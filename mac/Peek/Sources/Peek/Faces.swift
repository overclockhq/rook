import SwiftUI
import PeekCore

/// The palette is the machine's own chrome — the cutout black and the hairline
/// it already sits in. Coral is the one borrowed thing, and it means exactly
/// "this is waiting on you".
enum Ink {
    static let void = Color(red: 0.020, green: 0.020, blue: 0.024)
    static let on = Color(red: 0.941, green: 0.941, blue: 0.949)
    static let on2 = Color(red: 0.545, green: 0.549, blue: 0.576)
    static let edge = Color.white.opacity(0.11)
    static let edge2 = Color.white.opacity(0.06)

    static let coral = Color(red: 1.0, green: 0.361, blue: 0.227)
    static let critical = Color(red: 0.898, green: 0.282, blue: 0.302)
    static let waiting = Color(red: 0.910, green: 0.631, blue: 0.227)

    static func tone(_ t: PeekData.Tone) -> Color {
        switch t {
        case .neutral: return on2
        case .waiting: return waiting
        case .critical: return critical
        case .accent: return coral
        }
    }
}

/// Two type sizes, as specified. A third is noise at notch scale.
enum Face {
    static let line = Font.system(size: 12.5, weight: .semibold)
    static let meta = Font.system(size: 10.5, weight: .regular, design: .monospaced)
    static let count = Font.system(size: 12, weight: .medium, design: .monospaced)
}

// MARK: - Ambient

struct AmbientFace: View {
    let data: PeekData
    let notchWidth: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            signal(count: data.needsReview + data.waitingAgents,
                   label: "review", color: Ink.coral)
            // The camera sits dead centre; both counts clear it by half the notch.
            Spacer(minLength: notchWidth * 0.55)
            signal(count: data.blocked, label: "blocked", color: Ink.waiting)
        }
        .padding(.horizontal, 14)
    }

    @ViewBuilder
    private func signal(count: Int, label: String, color: Color) -> some View {
        if count > 0 {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text("\(count)").font(Face.count).foregroundStyle(Ink.on)
                Text(label).font(Face.meta).foregroundStyle(Ink.on2)
            }
        } else {
            Color.clear.frame(width: 1, height: 1)
        }
    }
}

// MARK: - PeekAlert

struct AlertFace: View {
    let alert: PeekAlert

    var body: some View {
        HStack(spacing: 11) {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Ink.critical.opacity(0.16))
                .overlay(Text("!").font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(Ink.critical))
                .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: 1) {
                Text(alert.title).font(Face.line).foregroundStyle(Ink.on).lineLimit(1)
                Text(alert.detail).font(Face.meta).foregroundStyle(Ink.on2).lineLimit(1)
            }
            Spacer(minLength: 6)
            Text("Open")
                .font(Face.meta).foregroundStyle(Ink.coral)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Ink.coral.opacity(0.4), lineWidth: 1))
        }
        .padding(.horizontal, 16)
    }
}

// MARK: - Spinner

struct Spinner: View {
    @State private var spin = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.28)
            .stroke(Ink.coral, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(reduceMotion ? nil : .linear(duration: 1).repeatForever(autoreverses: false),
                       value: spin)
            .onAppear { spin = true }
    }
}

// MARK: - Peek

struct PeekFace: View {
    let data: PeekData
    var onOpen: () -> Void
    var onRow: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !data.reviewRows.isEmpty {
                header("Needs you", data.needsReview + data.waitingAgents)
                ForEach(data.reviewRows) { r in rowView(r) }
            }
            if !data.blockedRows.isEmpty {
                if !data.reviewRows.isEmpty {
                    Rectangle().fill(Ink.edge).frame(height: 1).padding(.vertical, (PeekData.dividerH - 1) / 2)
                }
                header("Blocked", data.blocked)
                ForEach(data.blockedRows) { r in rowView(r) }
            }
            if let run = data.running {
                if !data.reviewRows.isEmpty || !data.blockedRows.isEmpty {
                    Rectangle().fill(Ink.edge).frame(height: 1).padding(.vertical, (PeekData.dividerH - 1) / 2)
                }
                HStack(spacing: 9) {
                    Spinner().frame(width: 11, height: 11)
                    Text(run.name)
                        .font(.system(size: 12)).foregroundStyle(Ink.on2).lineLimit(1)
                    Spacer(minLength: 6)
                    Text("running").font(Face.meta).foregroundStyle(Ink.on2)
                }
                .frame(height: PeekData.rowH)
            }

            if data.reviewRows.isEmpty && data.blockedRows.isEmpty && data.running == nil {
                Text("Nothing is waiting on you.")
                    .font(.system(size: 12)).foregroundStyle(Ink.on2)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 26)
            }

            // Never drop rows silently — a count you cannot see is worse than
            // no count at all.
            if data.overflow > 0 {
                Text("+\(data.overflow) more in rook")
                    .font(Face.meta).foregroundStyle(Ink.on2)
                    .frame(height: PeekData.overflowH, alignment: .leading)
            }

            Spacer(minLength: 0)
            button("Open rook", primary: true, action: onOpen)
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 14)
    }

    private func header(_ t: String, _ n: Int) -> some View {
        HStack {
            Text(t.uppercased())
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .tracking(0.8)
                .foregroundStyle(Ink.on2)
            Spacer()
            Text("\(n)").font(Face.meta).foregroundStyle(Ink.on2)
        }
        .frame(height: PeekData.sectionHeaderH)
    }

    private func rowView(_ r: PeekData.Row) -> some View {
        Button(action: { onRow(r.url ?? "") }) {
            HStack(spacing: 9) {
                Circle().fill(Ink.tone(r.tone)).frame(width: 6, height: 6)
                Text(r.ref)
                    .font(Face.meta).foregroundStyle(Ink.on2)
                    .frame(width: 42, alignment: .leading)
                Text(r.title)
                    .font(.system(size: 12)).foregroundStyle(Ink.on)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text(r.note)
                    .font(Face.meta)
                    .foregroundStyle(r.tone == .critical ? Ink.critical : Ink.on2)
            }
            .frame(height: PeekData.rowH)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func button(_ t: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(t)
                .font(Face.meta)
                .foregroundStyle(primary ? Ink.coral : Ink.on2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(primary ? Ink.coral.opacity(0.08) : .clear))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(primary ? Ink.coral.opacity(0.42) : Ink.edge, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Shell

/// The black mass every face sits in. It is continuous across states — it grows,
/// and the content arrives a beat later, which is the whole illusion.
struct PeekShell: View {
    let state: PeekState
    let data: PeekData
    let alert: PeekAlert?
    let geometry: NotchGeometry
    let now: Date
    var onOpen: () -> Void
    var onRow: (String) -> Void

    private var radius: CGFloat {
        switch state {
        case .dormant, .ambient: return 12
        case .alert, .live: return 16
        case .peek: return 20
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            UnevenRoundedRectangle(
                topLeadingRadius: geometry.hasNotch ? 0 : radius,
                bottomLeadingRadius: radius,
                bottomTrailingRadius: radius,
                topTrailingRadius: geometry.hasNotch ? 0 : radius,
                style: .continuous
            )
            .fill(Ink.void)

            content
                .transition(.opacity.combined(with: .offset(y: -4)))
                .id(state)
        }
        .clipped()
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .dormant:
            Color.clear
        case .ambient:
            AmbientFace(data: data, notchWidth: geometry.notchWidth)
                .frame(height: geometry.notchHeight)
        case .alert:
            if let alert { AlertFace(alert: alert).frame(height: 46) }
        case .peek:
            PeekFace(data: data, onOpen: onOpen, onRow: onRow)
        case .live:
            // Not a resting state any more — a running agent shows inside Peek.
            Color.clear
        }
    }
}
