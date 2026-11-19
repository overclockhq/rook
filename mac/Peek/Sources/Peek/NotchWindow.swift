import AppKit
import SwiftUI
import PeekCore

/// A borderless panel hung from the top of the screen.
///
/// It must sit above the menu bar, follow the user across Spaces, and never take
/// focus — clicking Peek should not pull you out of whatever you were typing in.
final class NotchPanel: NSPanel {
    init(frame: NSRect) {
        super.init(contentRect: frame,
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)

        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        // Above the menu bar, below system alerts.
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isMovable = false
        isMovableByWindowBackground = false
        hidesOnDeactivate = false
        animationBehavior = .none
    }

    // A panel that becomes key would steal the caret from the app underneath.
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Tracks hover over the panel and reports it up. AppKit handles this more
/// reliably than SwiftUI's onHover for a window that is resizing underneath the
/// cursor.
final class HoverView: NSView {
    var onEnter: () -> Void = {}
    var onExit: () -> Void = {}

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self))
    }

    override func mouseEntered(with event: NSEvent) { onEnter() }
    override func mouseExited(with event: NSEvent) { onExit() }
}

@MainActor
final class NotchWindowController {
    private let panel: NotchPanel
    private let hover: HoverView
    private let host: NSHostingView<AnyView>
    private(set) var geometry: NotchGeometry

    var onHoverEnter: () -> Void = {}
    var onHoverExit: () -> Void = {}

    init(screen: NSScreen) {
        geometry = NotchGeometry.read(screen)
        let start = geometry.frame(for: .dormant)

        panel = NotchPanel(frame: start)
        hover = HoverView(frame: NSRect(origin: .zero, size: start.size))
        hover.autoresizingMask = [.width, .height]
        host = NSHostingView(rootView: AnyView(EmptyView()))
        host.frame = hover.bounds
        host.autoresizingMask = [.width, .height]

        hover.addSubview(host)
        panel.contentView = hover
        hover.onEnter = { [weak self] in self?.onHoverEnter() }
        hover.onExit = { [weak self] in self?.onHoverExit() }
    }

    func show() { panel.orderFrontRegardless() }
    func hide() { panel.orderOut(nil) }

    func setContent<V: View>(_ view: V) {
        host.rootView = AnyView(view)
    }

    /// Re-read geometry when the display set changes — a new monitor, a
    /// resolution change, or the lid opening on a different screen.
    func rescan(screen: NSScreen, state: PeekState, panelHeight: CGFloat) {
        geometry = NotchGeometry.read(screen)
        apply(state: state, panelHeight: panelHeight, animated: false)
    }

    /// The morph. Width and height move together on a decelerating curve with no
    /// overshoot — overshoot on a shape cut into the bezel reads as a bug.
    func apply(state: PeekState, panelHeight: CGFloat = 244, animated: Bool = true) {
        let target = geometry.frame(for: state, panelHeight: panelHeight)

        guard animated else {
            panel.setFrame(target, display: true)
            return
        }

        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = state == .dormant ? 0.26 : 0.42   // leaving is a release, not a retreat
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.32, 0.72, 0, 1)
            ctx.allowsImplicitAnimation = true
            panel.animator().setFrame(target, display: true)
        }
    }
}
