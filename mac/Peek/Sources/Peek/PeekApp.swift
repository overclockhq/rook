import AppKit
import SwiftUI
import PeekCore

/// Menu-bar agent. No dock icon, no window of its own — the notch is the
/// interface, and the status item exists only so there is a way to quit.
@MainActor
final class PeekController: NSObject, NSApplicationDelegate {
    private let client = RookClient()
    private let machine = PeekMachine()
    private var controller: NotchWindowController?
    private var statusItem: NSStatusItem?

    private var pollTask: Task<Void, Never>?
    private var tick: Timer?
    private var now = Date()

    /// How often rook is asked. Two seconds matches the board's own poll and is
    /// cheap on loopback; the window only redraws when something actually changed.
    private static let pollInterval: Duration = .seconds(2)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        guard let screen = NSScreen.main else { return }
        let c = NotchWindowController(screen: screen)
        c.onHoverEnter = { [weak self] in self?.machine.mouseEntered() }
        c.onHoverExit = { [weak self] in self?.machine.mouseExited() }
        controller = c

        machine.onChange = { [weak self] state in
            guard let self else { return }
            self.controller?.apply(state: state, panelHeight: self.machine.data.panelHeight)
            self.render()
            if state == .dormant { self.controller?.hide() } else { self.controller?.show() }
        }

        buildStatusItem()
        observeDisplays()
        render()

        // Elapsed time in the Live face needs a second hand; nothing else does.
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.machine.state == .live else { return }
                self.now = Date()
                self.render()
            }
        }

        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let data = await self.client.poll()
                await MainActor.run {
                    self.machine.suppressed = Self.isPresenting()
                    self.machine.apply(data)
                    self.render()
                }
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTask?.cancel()
        tick?.invalidate()
    }

    // MARK: - render

    private func render() {
        guard let c = controller else { return }
        c.setContent(
            PeekShell(
                state: machine.state,
                data: machine.data,
                alert: machine.alert,
                geometry: c.geometry,
                now: now,
                onOpen: { Self.openRook() },
                onRow: { url in Self.open(url.isEmpty ? Self.rookURL : url) }
            )
            .animation(.easeOut(duration: 0.16).delay(0.09), value: machine.state)
        )
    }

    // MARK: - system awareness

    /// Screen sharing or a mirrored display: hold everything back. A demo
    /// interrupted by your own tooling is precisely what the rule prevents.
    private static func isPresenting() -> Bool {
        let screens = NSScreen.screens
        guard screens.count > 1 else { return false }
        // Mirrored displays report the same frame; treat that as presenting.
        let frames = Set(screens.map { "\($0.frame)" })
        return frames.count < screens.count
    }

    private func observeDisplays() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, let screen = NSScreen.main else { return }
                self.controller?.rescan(screen: screen, state: self.machine.state,
                                        panelHeight: self.machine.data.panelHeight)
                self.render()
            }
        }
    }

    // MARK: - status item

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "rectangle.topthird.inset.filled",
                                     accessibilityDescription: "Peek")
        let menu = NSMenu()
        menu.addItem(withTitle: "Open rook", action: #selector(openRookAction), keyEquivalent: "")
            .target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Peek", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
        statusItem = item
    }

    @objc private func openRookAction() { Self.openRook() }

    private static let rookURL = "http://127.0.0.1:7480/"
    private static func openRook() { open(rookURL) }
    private static func open(_ s: String) {
        guard let url = URL(string: s) else { return }
        NSWorkspace.shared.open(url)
    }
}

@main
struct PeekMain {
    static func main() {
        let app = NSApplication.shared
        let controller = PeekController()
        app.delegate = controller
        // Keep the delegate alive for the process lifetime.
        withExtendedLifetime(controller) {
            app.run()
        }
    }
}
