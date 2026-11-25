import SwiftUI
import KipurseCore

enum ButtonKind { case primary, secondary, danger, warm }

/// Full-width primary action (HIG: 50pt tall, 14pt continuous radius).
/// t1243 (owner: "[zh]"): icon + title centered as ONE group across the whole button width;
/// a plain Label hugs the leading edge when its title wraps or the button is wider than the label.
struct CenteredLabel: View {
  let title: String; let icon: String
  init(_ title: String, systemImage: String) { self.title = title; self.icon = systemImage }
  var body: some View {
    HStack(spacing: 6) { Image(systemName: icon); Text(title).multilineTextAlignment(.center) }
      .frame(maxWidth: .infinity, alignment: .center)
      .accessibilityElement(children: .combine)
  }
}
struct BigButton: View {
  let title: String; var kind: ButtonKind; var disabled = false; var icon: String? = nil; let action: () -> Void
  @State private var taps = 0
  @Environment(\.colorScheme) private var scheme
  init(_ t: String, color: Color = .blue, kind: ButtonKind? = nil, icon: String? = nil, disabled: Bool = false, action: @escaping () -> Void) {
    title = t; self.disabled = disabled; self.icon = icon; self.action = action
    self.kind = kind ?? (color == .gray ? .secondary : color == .red ? .danger : color == .orange ? .warm : .primary)
  }
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous)
    Button { Haptics.tap(); taps += 1; action() } label: {
      HStack(spacing: 8) {
        if let i = icon { Image(systemName: i).kBounce(taps) }
        Text(title).multilineTextAlignment(.center)
      }
      .font(.headline).frame(maxWidth: .infinity, minHeight: 54).padding(.horizontal, 12)
      .foregroundStyle(fg)
      .background { if kind == .primary { shape.fill(KP.brandGradient) } else { shape.fill(bg) } }
      .overlay { if kind == .primary { shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.45), .white.opacity(0.05)], startPoint: .top, endPoint: .bottom), lineWidth: 1) } }
      .shadow(color: kind == .primary && !disabled ? Brand.accent.opacity(scheme == .dark ? 0.55 : 0.35) : .clear, radius: 14, y: 6)
    }
    .buttonStyle(Pressable()).disabled(disabled).opacity(disabled ? 0.4 : 1)
  }
  private var bg: Color { switch kind { case .primary: return Brand.accent; case .secondary: return Brand.accentSoft; case .danger: return Brand.negative.opacity(0.12); case .warm: return Brand.caution.opacity(0.14) } }
  private var fg: Color { switch kind { case .primary: return .white; case .secondary: return Brand.accent; case .danger: return Brand.negative; case .warm: return Brand.caution } }
}

/// Glow + shine for system `.borderedProminent` primary buttons (key actions).
struct Glow: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  func body(content: Content) -> some View { content.shadow(color: Brand.accent.opacity(scheme == .dark ? 0.55 : 0.32), radius: 14, y: 6) }
}
extension View { func kGlow() -> some View { modifier(Glow()) } }

/// Preset chips (2x2) + L("[zh]") field with the right keypad. Presets are examples; nothing pre-selected.
struct AmountPicker: View {
  let title: String; let presets: [String]; let unit: String; var isDays = false
  /// t1116 (withdraw only; nil keeps every other page unchanged): presets above this atomic USDC amount are unavailable,
  /// and `idPrefix` gives the tiles / field clear ids ("<prefix>.all", "<prefix>.preset.<n>", "<prefix>.custom").
  var maxAtomic: Int64? = nil; var idPrefix: String? = nil
  /// t1185: whole-number counts (daily on-chain operations): own hint + footer, number pad. nil keeps every other picker unchanged.
  var countHint: String? = nil; var countFooter: String? = nil
  /// t1245 (decision 115 U10): the "1 USDC ≈ US$1 …" line once per page — later pickers on the same page pass false.
  var showFooter = true
  @Binding var value: String
  @State private var custom = ""
  @FocusState private var focused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.headline).fixedSize(horizontal: false, vertical: true)
      VStack(spacing: 10) { ForEach(Array(stride(from: 0, to: presets.count, by: 2)), id: \.self) { i in HStack(spacing: 10) {
        ForEach(presets[i..<min(i + 2, presets.count)], id: \.self) { p in
          let sel = value == p && custom.isEmpty
          let off = maxAtomic.map { !WithdrawAmount.presetAvailable(p, total: $0) } ?? false
          Button { Haptics.select(); value = p; custom = ""; focused = false } label: {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
              Text(p).font(Brand.money(22, .semibold))
              if Double(p) != nil { Text(unit).font(.footnote.weight(.medium)).foregroundStyle(sel ? Color.white.opacity(0.85) : .secondary) }   // t1245 U32: 「全部」 has no unit
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(sel ? Color.white : .primary)
            .background(sel ? Brand.accent : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous))
          }.buttonStyle(Pressable()).disabled(off).opacity(off ? 0.4 : 1).accessibilityLabel(Double(p) != nil ? "\(p) \(unit)" : p).accessibilityAddTraits(sel ? .isSelected : [])
          .modifier(OptionalA11yID(id: idPrefix.map { WithdrawAmount.atomic(p) == nil ? "\($0).all" : "\($0).preset.\(p)" }))
        }
      } } }
      HStack(spacing: 8) {
        Image(systemName: "pencil").foregroundStyle(.secondary)
        TextField(countHint ?? (isDays ? L("自己填（\(AnswerRules.termMinDays)–\(AnswerRules.termMaxDays)）") : L("自己填，例如 3.5")), text: $custom)
          .keyboardType(isDays || countHint != nil ? .numberPad : .decimalPad).focused($focused)
          .accessibilityIdentifier(idPrefix.map { "\($0).custom" } ?? "amount.custom.\(title)")
          .font(Brand.money(20, .semibold))
          .onChange(of: custom) { v in if !v.isEmpty { value = v } }
        Text(unit).font(.subheadline).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 14).frame(minHeight: 52)
      .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous).strokeBorder(Brand.accent, lineWidth: focused || !custom.isEmpty ? 2 : 0))
      if showFooter || countFooter != nil || isDays {
        Text(countFooter ?? (isDays ? L("可以选 1 到 365 天。") : T("1 USDC ≈ 1 美元，可以填小数，比如 2.5。上面只是例子，你自己选。", "1 USDC ≈ US$1. Decimals are fine, like 2.5. These are only examples."))).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    .preference(key: AmountKeyboardFocusKey.self, value: focused)
    .onAppear { if custom.isEmpty, !value.isEmpty, !presets.contains(value) { custom = value } }  // show current non-preset value instead of an empty picker
  }
}

/// t1116: sets an accessibility id only when one is given (nil = leave the element exactly as before).
private struct OptionalA11yID: ViewModifier {
  let id: String?
  func body(content: Content) -> some View { if let id { content.accessibilityIdentifier(id) } else { content } }
}

// One accessory per screen, driven by the active picker. A safe-area accessory also
// avoids SwiftUI merging sibling toolbars or dropping keyboard items on navigation.
private struct AmountKeyboardFocusKey: PreferenceKey {
  static var defaultValue = false
  static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}
private struct AmountKeyboardToolbar: ViewModifier {
  @State private var focused = false
  func body(content: Content) -> some View {
    content
      .onPreferenceChange(AmountKeyboardFocusKey.self) { focused = $0 }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if focused {
          HStack {
            Spacer()
            Button(L("完成")) {
              UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }.bold().accessibilityIdentifier("amount.done")
              .frame(minWidth: 60, minHeight: 44)
          }.padding(.horizontal, 16).background(.bar)
        }
      }
  }
}
extension View {
  func amountKeyboardToolbar() -> some View { modifier(AmountKeyboardToolbar()) }
}

struct WarnBox: View {
  let text: String; var tone: Color = Brand.caution; var icon = "exclamationmark.triangle.fill"
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: icon).foregroundStyle(tone)
      Text(text).font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
    }
    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
    .background(tone.opacity(0.10), in: RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous))
  }
}
struct ErrorText: View { let text: String
  var body: some View { Label(text, systemImage: "exclamationmark.circle.fill").foregroundStyle(Brand.negative).font(.subheadline.weight(.semibold)) } }

/// Thin segmented progress for the setup flow.
struct StepProgress: View {
  let current: Int, total: Int
  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<total, id: \.self) { i in
        Capsule().fill(i <= current ? Brand.accent : Color(uiColor: .tertiarySystemFill)).frame(height: 4)
      }
    }
    .animation(Brand.spring, value: current)
    .accessibilityElement(children: .ignore).accessibilityLabel(L("第 \(current + 1) 步，共 \(total) 步"))
  }
}

struct SectionTitle: View { let text: String; var icon: String
  var body: some View { Label(text, systemImage: icon).font(.headline) } }

/// Section header used above cards (HIG grouped style).
struct Header: View { let text: String; var trailing: String? = nil
  var body: some View {
    HStack { Text(text).font(KP.Typo.section); Spacer(); if let t = trailing { Text(t).font(.subheadline).foregroundStyle(.secondary) } }
      .padding(.horizontal, 0)
  }
}

/// Progress ring: spent vs limit.
struct LimitRing: View {
  let title: String; let used: Int64; let limit: Int64
  var frac: Double { limit > 0 ? min(1, Double(used) / Double(limit)) : 0 }
  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        Circle().stroke(Color(uiColor: .tertiarySystemFill), lineWidth: 7)
        Circle().trim(from: 0, to: frac).stroke(frac > 0.85 ? Brand.caution : Brand.accent, style: StrokeStyle(lineWidth: 7, lineCap: .round)).rotationEffect(.degrees(-90))
        Text("\(Int((frac * 100).rounded()))%").font(Brand.money(12, .semibold))
      }.frame(width: 52, height: 52).animation(Brand.spring, value: frac)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.caption).foregroundStyle(.secondary)
        Text(AnswerRules.format(used)).font(Brand.money(17, .semibold))
        Text("/ \(AnswerRules.format(limit)) USDC").font(.caption2).foregroundStyle(.secondary).monospacedDigit()
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}


/// A money amount that follows the shared hide/show state: "••••••" in the SAME font when hidden; tapping the mask asks Face ID.
struct MaskedAmount: View {
  @EnvironmentObject var m: AppModel
  let text: String; var font: Font = .body; var id: String? = nil
  var body: some View {
    if m.balanceRevealed { Text(text).font(font).accessibilityIdentifier(id ?? "") }
    else {
      Text(BalanceMask.dots).font(font).foregroundStyle(.primary)
        .onTapGesture { Task { await m.revealBalance() } }
        .accessibilityLabel(T("已隐藏，点按用 Face ID 显示", "Hidden, tap to show with Face ID")).accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(id.map { $0 + ".masked" } ?? "")
    }
  }
}
enum BalanceMask { static let dots = "••••••"; static let short = "••••" }

/// Standard wallet eye toggle (one shared state: AppModel.balanceRevealed). eye.slash = hidden -> tap = reveal (no Face ID, t889); eye = shown -> tap = hide now.
struct BalanceEyeButton: View {
  @EnvironmentObject var m: AppModel
  var font: Font = .title3
  var body: some View {
    Button {
      if m.balanceRevealed { withAnimation(Brand.spring) { m.hideBalance() } } else { Task { await m.revealBalance() } }
    } label: {
      Image(systemName: m.balanceRevealed ? "eye" : "eye.slash").font(font).foregroundStyle(.secondary)
        .frame(minWidth: 32, minHeight: 32).contentShape(Rectangle())
    }.buttonStyle(.plain)
    .accessibilityLabel(m.balanceRevealed ? T("隐藏余额", "Hide balance") : T("显示余额", "Show balance"))
    .accessibilityIdentifier(m.balanceRevealed ? "balance.hide" : "balance.reveal")
  }
}

/// t927: horizontal at normal text sizes, vertical at accessibility sizes (no squeezed / split buttons).
struct AdaptiveStack<Content: View>: View {
  @Environment(\.dynamicTypeSize) private var dts
  @ViewBuilder let content: () -> Content
  var body: some View {
    if dts.isAccessibilitySize { VStack(alignment: .leading, spacing: 8) { content() } } else { HStack(spacing: 10) { content() } }
  }
}
