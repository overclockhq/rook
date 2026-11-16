import AppKit
import PeekCore

/// Where the notch physically is, read from the hardware rather than assumed.
///
/// On a notched Mac the screen reports two "auxiliary" areas flanking the
/// cutout; what sits between them is the notch. Machines without one report no
/// auxiliary areas, and Peek falls back to a centred pill of the same
/// proportion — the spec's no-notch case.
struct NotchGeometry {
    let screen: NSScreen
    let notchWidth: CGFloat
    let notchHeight: CGFloat
    let hasNotch: Bool

    /// Widths in the spec are multiples of the notch width, which is a constant
    /// 12.2% of screen width on every notched Mac. One set of numbers therefore
    /// covers 14", 16" and the no-notch fallback alike.
    static func read(_ screen: NSScreen) -> NotchGeometry {
        let full = screen.frame.width
        let left = screen.auxiliaryTopLeftArea?.width
        let right = screen.auxiliaryTopRightArea?.width
        let inset = screen.safeAreaInsets.top

        if let l = left, let r = right, inset > 0 {
            let w = max(0, full - l - r)
            if w > 40 {
                return NotchGeometry(screen: screen, notchWidth: w,
                                     notchHeight: inset, hasNotch: true)
            }
        }
        // No cutout: keep the same 12.2% proportion so every geometry below still
        // lands where the spec says it should.
        return NotchGeometry(screen: screen,
                             notchWidth: (full * 0.122).rounded(),
                             notchHeight: NSStatusBar.system.thickness,
                             hasNotch: false)
    }

    func size(for state: PeekState, panelHeight: CGFloat = 244) -> CGSize {
        switch state {
        case .dormant: return CGSize(width: notchWidth, height: notchHeight)
        case .ambient: return CGSize(width: notchWidth * 1.4, height: notchHeight)
        case .alert, .live: return CGSize(width: notchWidth * 1.8, height: 46)
        case .peek: return CGSize(width: notchWidth * 2.1, height: panelHeight)
        }
    }

    /// Window origin so the surface stays centred on the cutout and flush with
    /// the top of the display.
    func frame(for state: PeekState, panelHeight: CGFloat = 244) -> NSRect {
        let s = size(for: state, panelHeight: panelHeight)
        let f = screen.frame
        return NSRect(x: f.midX - s.width / 2,
                      y: f.maxY - s.height,
                      width: s.width, height: s.height)
    }
}
