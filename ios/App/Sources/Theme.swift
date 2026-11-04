import SwiftUI
import KipurseCore
#if canImport(UIKit)
import UIKit
#endif

/// Kipurse design system: restrained fintech. One brand accent (Kipurse indigo), system grouped backgrounds,
/// SF Pro Rounded + monospaced digits for money, subtle shadows, light-first with a proper dark mode. HIG spacing (8-pt grid).
enum Brand {
  /// The single accent. Light: #5B4CF0, dark: #8B7CFF (lifted for contrast on black).
  static let accent = Color(light: 0x5B4CF0, dark: 0x8B7CFF)
  static let accentSoft = Color(light: 0x5B4CF0, dark: 0x8B7CFF).opacity(0.12)
  static let positive = Color(light: 0x0E9F6E, dark: 0x34D399)
  static let caution = Color(light: 0xB45309, dark: 0xFBBF24)
  static let negative = Color(light: 0xDC2626, dark: 0xF87171)
  /// Lifted accent for gradients / shine (top of the primary button, hero card).
  static let accentHi = Color(light: 0x7C6CFF, dark: 0xA79BFF)
  /// Deep end of the hero gradient (Apple Card–style indigo night).
  static let accentDeep = Color(light: 0x2E1F9E, dark: 0x1B1260)
  static let card = Color(uiColor: .secondarySystemGroupedBackground)
  /// App background: rich indigo-night gradient in dark mode, soft lavender mist in light mode (solid when Reduce Transparency is on).
  static var canvas: KCanvas { KCanvas() }
  static let hairline = Color(uiColor: .separator)
  static let radius: CGFloat = 20
  /// Spring for every transition; a short fade when Reduce Motion is on.
  static var spring: Animation { UIAccessibility.isReduceMotionEnabled ? .easeInOut(duration: 0.18) : .spring(response: 0.38, dampingFraction: 0.82) }
  static func money(_ size: CGFloat, _ w: Font.Weight = .bold) -> Font { .system(size: UIFontMetrics(forTextStyle: .largeTitle).scaledValue(for: size), weight: w, design: .rounded).monospacedDigit() }
}

extension Color {
  init(hex: UInt32, opacity: Double = 1) {
    self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
  }
  init(light: UInt32, dark: UInt32) {
    #if canImport(UIKit)
    self.init(uiColor: UIColor { t in
      let h = t.userInterfaceStyle == .dark ? dark : light
      return UIColor(red: CGFloat((h >> 16) & 0xFF) / 255, green: CGFloat((h >> 8) & 0xFF) / 255, blue: CGFloat(h & 0xFF) / 255, alpha: 1)
    })
    #else
    self.init(hex: light)
    #endif
  }
}

enum Haptics {
  static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
  static func select() { UISelectionFeedbackGenerator().selectionChanged() }
  static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
  static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
  static func warn() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}

/// Background gradient. Reduce Transparency -> flat system grouped colour.
struct KCanvas: View {
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceTransparency) private var rt
  var body: some View {
    let dark = scheme == .dark
    ZStack {
      if rt { Color(uiColor: .systemGroupedBackground) }
      else {
        LinearGradient(colors: dark ? [Color(hex: 0x100C2E), Color(hex: 0x0A0820), Color(hex: 0x050510)] : [Color(hex: 0xF4F2FF), Color(hex: 0xEFEEFA), Color(hex: 0xF7F7FB)], startPoint: .top, endPoint: .bottom)
        RadialGradient(colors: [Brand.accent.opacity(dark ? 0.38 : 0.13), .clear], center: UnitPoint(x: 0.1, y: 0.0), startRadius: 0, endRadius: 460)
        RadialGradient(colors: [Color(hex: 0x22D3EE).opacity(dark ? 0.10 : 0.05), .clear], center: UnitPoint(x: 1.0, y: 0.95), startRadius: 0, endRadius: 420)
      }
    }.ignoresSafeArea()
  }
}

/// Glass card: system material over the gradient, hairline shine border, soft depth. Solid card when Reduce Transparency is on.
struct Card: ViewModifier {
  var padding: CGFloat = 16
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceTransparency) private var rt
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: Brand.radius, style: .continuous)
    let dark = scheme == .dark
    return content.padding(padding).frame(maxWidth: .infinity, alignment: .leading)
      .background { if rt { shape.fill(Brand.card) } else { shape.fill(.regularMaterial) } }
      .overlay(shape.strokeBorder(LinearGradient(colors: [.white.opacity(dark ? 0.16 : 0.8), .white.opacity(dark ? 0.03 : 0.25)], startPoint: .top, endPoint: .bottom), lineWidth: 1))
      .shadow(color: .black.opacity(dark ? 0.35 : 0.06), radius: 18, y: 8)
  }
}

/// SF Symbol effects (iOS 17+); nothing when Reduce Motion is on or on iOS 16.
struct SymbolBounce<V: Equatable>: ViewModifier {
  let value: V
  @Environment(\.accessibilityReduceMotion) private var rm
  func body(content: Content) -> some View {
    if #available(iOS 17, *), !rm { content.symbolEffect(.bounce, value: value) } else { content }
  }
}
struct SymbolPulse: ViewModifier {
  var active = true
  @Environment(\.accessibilityReduceMotion) private var rm
  func body(content: Content) -> some View {
    if #available(iOS 17, *), !rm { content.symbolEffect(.pulse, isActive: active) } else { content }
  }
}
extension View {
  func kBounce<V: Equatable>(_ v: V) -> some View { modifier(SymbolBounce(value: v)) }
  func kPulse(_ on: Bool = true) -> some View { modifier(SymbolPulse(active: on)) }
}

/// ⓘ: the one place an explanation lives (progressive disclosure). Opens a short sheet; 44pt target; VoiceOver reads the topic.
struct InfoTip: View {
  let title: String; let text: String; var id: String? = nil
  @State private var show = false
  var body: some View {
    Button { Haptics.select(); show = true } label: {
      Image(systemName: "info.circle").font(.body.weight(.medium)).foregroundStyle(Brand.accent)
        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }.buttonStyle(.plain)
    .accessibilityLabel(T("说明：", "About: ") + title).accessibilityIdentifier(id ?? "info")
    .sheet(isPresented: $show) {
      NavigationStack {
        ScrollView { Text(text).font(.body).fixedSize(horizontal: false, vertical: true).padding(24).frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier((id ?? "info") + ".text") }
          .background(Brand.canvas).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
          .toolbar { Button(T("完成", "Done")) { show = false }.bold().accessibilityIdentifier("info.done") }
      }.presentationDetents([.medium, .large])
    }
  }
}
extension View { func card(padding: CGFloat = 16) -> some View { modifier(Card(padding: padding)) } }

/// Gentle press feedback.
struct Pressable: ButtonStyle {
  func makeBody(configuration c: Configuration) -> some View {
    c.label.scaleEffect(c.isPressed ? 0.97 : 1).opacity(c.isPressed ? 0.85 : 1)
      .animation(.easeOut(duration: 0.15), value: c.isPressed)
  }
}

/// The Kipurse "K·" mark (matches the app icon): accent rounded square, white K and dot.
struct BrandMark: View {
  var size: CGFloat = 56
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.27, style: .continuous).fill(Brand.accent)
      KGlyph().stroke(.white, style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round, lineJoin: .round))
      Circle().fill(.white).frame(width: size * 0.13, height: size * 0.13).offset(x: size * 0.23)
    }.frame(width: size, height: size)
  }
  struct KGlyph: Shape {
    func path(in r: CGRect) -> Path {
      let u = r.width / 64; var p = Path()
      p.move(to: CGPoint(x: 22 * u, y: 17 * u)); p.addLine(to: CGPoint(x: 22 * u, y: 47 * u))
      p.move(to: CGPoint(x: 40 * u, y: 18 * u)); p.addLine(to: CGPoint(x: 26.5 * u, y: 32 * u)); p.addLine(to: CGPoint(x: 40 * u, y: 46 * u))
      return p
    }
  }
}

/// Tasteful but unmistakable test-mode indicator: a slim amber strip under the status bar.

/// Shown on every screen when the paired server runs on Base mainnet (real money).
struct MainnetRibbon: View {
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "dollarsign.circle.fill")
      Text(L("正式版")).lineLimit(1).minimumScaleFactor(0.75)
    }
    .font(.footnote.weight(.semibold)).foregroundColor(.white)
    .padding(.vertical, 6).frame(maxWidth: .infinity)
    .background(Color(hex: 0x0B6E4F))
    .accessibilityLabel(L("正式版"))
  }
}

/// Small status chip.
struct Chip: View {
  let text: String; var color: Color = Brand.accent; var icon: String? = nil
  var body: some View {
    HStack(spacing: 4) { if let i = icon { Image(systemName: i).imageScale(.small) }; Text(text) }
      .font(.caption.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 4)
      .background(color.opacity(0.12), in: Capsule()).foregroundStyle(color)
  }
}

/// Circular initials avatar for an agent / payee (stable color from the name).
struct Avatar: View {
  let name: String; var size: CGFloat = 40; var symbol: String? = nil
  private static let hues: [UInt32] = [0x5B4CF0, 0x0E9F6E, 0xD97706, 0x2563EB, 0xDB2777, 0x0891B2]
  var body: some View {
    let c = Color(hex: Avatar.hues[name.unicodeScalars.reduce(0) { $0 + Int($1.value) } % Avatar.hues.count])
    ZStack {
      Circle().fill(c.opacity(0.14))
      if let s = symbol { Image(systemName: s).font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(c) }
      else { Text(String(name.prefix(1)).uppercased()).font(.system(size: size * 0.42, weight: .bold, design: .rounded)).foregroundStyle(c) }
    }.frame(width: size, height: size)
  }
}

/// Hero colour field: slowly drifting soft blobs (Apple Card–style). Static when Reduce Motion is on.
struct HeroMesh: View {
  @Environment(\.accessibilityReduceMotion) private var rm
  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: rm)) { tl in
      let t = rm ? 0 : tl.date.timeIntervalSinceReferenceDate
      GeometryReader { g in
        let w = g.size.width, h = g.size.height
        ZStack {
          Circle().fill(Color(hex: 0xA855F7).opacity(0.55)).frame(width: w * 0.9).blur(radius: 40)
            .offset(x: w * (0.25 + 0.12 * sin(t / 5)), y: h * (-0.35 + 0.10 * cos(t / 6)))
          Circle().fill(Color(hex: 0x22D3EE).opacity(0.35)).frame(width: w * 0.7).blur(radius: 46)
            .offset(x: w * (-0.35 + 0.10 * cos(t / 7)), y: h * (0.40 + 0.08 * sin(t / 4.5)))
          Circle().fill(Color(hex: 0x3B1DDB).opacity(0.6)).frame(width: w * 0.8).blur(radius: 50)
            .offset(x: w * (0.30 + 0.08 * sin(t / 8)), y: h * (0.45 + 0.06 * cos(t / 5.5)))
        }.frame(width: w, height: h)
      }
    }.blendMode(.plusLighter).opacity(0.85).allowsHitTesting(false)
  }
}

/// A thin light streak that glides across the hero every few seconds. None when Reduce Motion is on.
struct HeroSheen: View {
  @Environment(\.accessibilityReduceMotion) private var rm
  var body: some View {
    if rm { Color.clear } else {
      TimelineView(.animation(minimumInterval: 1 / 30)) { tl in
        let p = tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 6) / 6   // 0…1 every 6 s
        GeometryReader { g in
          LinearGradient(colors: [.clear, .white.opacity(0.22), .clear], startPoint: .leading, endPoint: .trailing)
            .frame(width: g.size.width * 0.35).rotationEffect(.degrees(20))
            .offset(x: -g.size.width * 0.5 + g.size.width * 2.0 * min(1, p * 1.6))
            .frame(maxHeight: .infinity)
        }
      }.blendMode(.plusLighter).allowsHitTesting(false)
    }
  }
}

/// Press-to-tilt depth on the hero (off with Reduce Motion).
struct HeroTilt: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var rm
  @GestureState private var press = false
  func body(content: Content) -> some View {
    if rm { content } else {
      content.scaleEffect(press ? 0.985 : 1).rotation3DEffect(.degrees(press ? 4 : 0), axis: (x: 1, y: -0.4, z: 0))
        .animation(.spring(response: 0.35, dampingFraction: 0.7), value: press)
        .simultaneousGesture(DragGesture(minimumDistance: 0).updating($press) { _, s, _ in s = true })
    }
  }
}

/// Three-step "how it works" strip under the main deposit action (fills the space with the one explanation beginners need).
struct HowItWorksStrip: View {
  let steps: [(String, String)]
  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
        VStack(spacing: 8) {
          ZStack { Circle().fill(Brand.accentSoft).frame(width: 44, height: 44); Image(systemName: s.0).font(.body.weight(.semibold)).foregroundStyle(Brand.accent) }
          Text(s.1).font(.footnote.weight(.medium)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity)
        if i < steps.count - 1 { Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary).padding(.top, 14) }
      }
    }.card(padding: 16).accessibilityElement(children: .combine).accessibilityIdentifier("deposit.how")
  }
}
