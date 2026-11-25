import SwiftUI

/// t991 — THE Kipurse design system (frozen). Every screen takes colours, type, spacing and radii from here.
/// Changing a value here changes every screen and fails the UI snapshot tests (UITests/UISnapshotUITests) on purpose:
/// re-approve the reference screenshots only together with an update of ~/t968/UI_SPEC.md.
enum KP {
  /// 8-pt spacing scale.
  enum Space { static let xxs: CGFloat = 4, xs: CGFloat = 8, s: CGFloat = 12, m: CGFloat = 16, page: CGFloat = 20, l: CGFloat = 24, xl: CGFloat = 32
    /// t1039: THE card rhythm. cardGap = between cards in one block; sectionGap = between blocks. No other gaps between cards anywhere.
    static let cardGap: CGFloat = s, sectionGap: CGFloat = l, headGap: CGFloat = xs }
  /// Four radii only.
  enum Radius { static let chip: CGFloat = 8, control: CGFloat = 14, card: CGFloat = 20, hero: CGFloat = 26 }
  /// Type ramp (Dynamic Type aware via system styles).
  enum Typo {
    static let pageTitle = Font.system(size: 34, weight: .heavy)
    static let section = Font.system(.title3, design: .default).weight(.bold)
    static let cardTitle = Font.headline
    static let body = Font.subheadline
    static let meta = Font.footnote
    static let caption = Font.caption
    static let button = Font.system(.body).weight(.semibold)
  }
  /// kipurse.com brand: purple → cyan.
  enum Palette {
    static let purple = Color(light: 0x6D3AF5, dark: 0x8B5CF6)
    static let cyan = Color(light: 0x0891B2, dark: 0x22D3EE)
    static let ink = Color.primary
    static let sub = Color.secondary
  }
  static var brandGradient: LinearGradient { LinearGradient(colors: [Color(hex: 0x7C3AED), Color(hex: 0x4F46E5), Color(hex: 0x0891B2)], startPoint: .leading, endPoint: .trailing) }
  static let buttonHeight: CGFloat = 54
  /// t1040: inset fill inside glass cards on every sub-page (replaces system grey/white).
  static let surface = Color(light: 0xF2F2F7, dark: 0xFFFFFF).opacity(0.06)
}

/// Section header used on every page ([zh] / …). Aligned with the card edge.
struct KPSectionHeader: View {
  let title: String; var link: String? = nil; var linkID = ""; var action: (() -> Void)? = nil
  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title).font(KP.Typo.section).accessibilityAddTraits(.isHeader)
      Spacer()
      if let l = link, let a = action { Button(l) { Haptics.tap(); a() }.font(.subheadline.weight(.semibold)).foregroundStyle(Brand.accent).accessibilityIdentifier(linkID) }
    }
  }
}

/// Primary (brand gradient) / secondary (tinted) action tile used in pairs, e.g. [zh] | [zh].
struct KPActionButton: View {
  enum Kind { case primary, secondary }
  let title: String; let icon: String; var kind: Kind = .primary; var disabled = false; let action: () -> Void
  var body: some View {
    let sh = RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous)
    Button { Haptics.tap(); action() } label: {
      Label(title, systemImage: icon).font(KP.Typo.button).lineLimit(1).minimumScaleFactor(0.8)
        .foregroundStyle(kind == .primary ? Color.white : (disabled ? Color.secondary : Brand.accent))
        .frame(maxWidth: .infinity, minHeight: KP.buttonHeight)
        .background {
          if kind == .primary { sh.fill(KP.brandGradient) } else { sh.fill(.regularMaterial); sh.fill(Brand.accentSoft) }
        }
        .overlay(sh.strokeBorder(kind == .primary ? Color.white.opacity(0.25) : Brand.accent.opacity(disabled ? 0.12 : 0.28), lineWidth: 1))
        .shadow(color: kind == .primary ? Color(hex: 0x5B2CFF).opacity(0.30) : .clear, radius: 12, y: 6)
    }.buttonStyle(Pressable()).disabled(disabled)
  }
}

/// Tinted notice row (one style for every inline notice: allowance requests, holds, verification, warnings).
/// t1066: clear transparent glass base + tint wash + neon rim.
struct KPNotice<Content: View>: View {
  var tint: Color = Brand.accent
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceTransparency) private var rt
  @ViewBuilder let content: () -> Content
  var body: some View {
    let sh = RoundedRectangle(cornerRadius: KP.Radius.card, style: .continuous)
    let dark = scheme == .dark
    content().padding(KP.Space.m).frame(maxWidth: .infinity, alignment: .leading)
      .background {
        KPGlass.fill(sh, dark: dark, rt: rt)
        sh.fill(tint.opacity(dark ? 0.12 : 0.10))
      }
      .overlay(KPGlass.rim(sh, dark: dark))
      .overlay(sh.strokeBorder(tint.opacity(dark ? 0.22 : 0.20), lineWidth: 0.8))
  }
}

/// Snapshot tests launch with -kpStill: decorative motion (sheen, mesh, symbol pulses) is frozen, exactly like Reduce Motion.
enum KPStill { static let on = CommandLine.arguments.contains("-kpStill") }

/// t1039: grouped lists use the same block gap as the scroll pages.
extension View {
  @ViewBuilder func kpSectionRhythm() -> some View {
    if #available(iOS 17.0, *) { self.listSectionSpacing(KP.Space.sectionGap) } else { self }
  }
}
