import SwiftUI
import KipurseCore

enum ButtonKind { case primary, secondary, danger, warm }

/// Full-width primary action (HIG: 50pt tall, 14pt continuous radius).
struct BigButton: View {
  let title: String; var kind: ButtonKind; var disabled = false; var icon: String? = nil; let action: () -> Void
  @State private var taps = 0
  @Environment(\.colorScheme) private var scheme
  init(_ t: String, color: Color = .blue, kind: ButtonKind? = nil, icon: String? = nil, disabled: Bool = false, action: @escaping () -> Void) {
    title = t; self.disabled = disabled; self.icon = icon; self.action = action
    self.kind = kind ?? (color == .gray ? .secondary : color == .red ? .danger : color == .orange ? .warm : .primary)
  }
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
    Button { Haptics.tap(); taps += 1; action() } label: {
      HStack(spacing: 8) {
        if let i = icon { Image(systemName: i).kBounce(taps) }
        Text(title).multilineTextAlignment(.center)
      }
      .font(.headline).frame(maxWidth: .infinity, minHeight: 54).padding(.horizontal, 12)
      .foregroundStyle(fg)
      .background { if kind == .primary { shape.fill(LinearGradient(colors: [Brand.accentHi, Brand.accent], startPoint: .top, endPoint: .bottom)) } else { shape.fill(bg) } }
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

/// Preset chips (2x2) + L("自己填") field with the right keypad. Presets are examples; nothing pre-selected.
struct AmountPicker: View {
  let title: String; let presets: [String]; let unit: String; var isDays = false
  @Binding var value: String
  @State private var custom = ""
  @FocusState private var focused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.headline).fixedSize(horizontal: false, vertical: true)
      VStack(spacing: 10) { ForEach(Array(stride(from: 0, to: presets.count, by: 2)), id: \.self) { i in HStack(spacing: 10) {
        ForEach(presets[i..<min(i + 2, presets.count)], id: \.self) { p in
          let sel = value == p && custom.isEmpty
          Button { Haptics.select(); value = p; custom = ""; focused = false } label: {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
              Text(p).font(Brand.money(22, .semibold))
              Text(unit).font(.footnote.weight(.medium)).foregroundStyle(sel ? Color.white.opacity(0.85) : .secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(sel ? Color.white : .primary)
            .background(sel ? Brand.accent : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          }.buttonStyle(Pressable()).accessibilityLabel("\(p) \(unit)").accessibilityAddTraits(sel ? .isSelected : [])
        }
      } } }
      HStack(spacing: 8) {
        Image(systemName: "pencil").foregroundStyle(.secondary)
        TextField(isDays ? L("自己填（\(AnswerRules.termMinDays)–\(AnswerRules.termMaxDays)）") : L("自己填，例如 3.5"), text: $custom)
          .keyboardType(isDays ? .numberPad : .decimalPad).focused($focused)
          .font(Brand.money(20, .semibold))
          .onChange(of: custom) { v in if !v.isEmpty { value = v } }
        Text(unit).font(.subheadline).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 14).frame(minHeight: 52)
      .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Brand.accent, lineWidth: focused || !custom.isEmpty ? 2 : 0))
      Text(isDays ? L("可以选 1 到 365 天。") : L("1 USDC ≈ 1 美元，可以填小数，比如 2.5。上面只是例子，你自己选。")).font(.footnote).foregroundStyle(.secondary)
    }
    .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button(L("完成")) { focused = false }.bold() } }
    .onAppear { if custom.isEmpty, !value.isEmpty, !presets.contains(value) { custom = value } }  // show current non-preset value instead of an empty picker
  }
}

struct WarnBox: View {
  let text: String; var tone: Color = Brand.caution; var icon = "exclamationmark.triangle.fill"
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: icon).foregroundStyle(tone)
      Text(text).font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
    }
    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
    .background(tone.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
    HStack { Text(text).font(.title3.weight(.bold)); Spacer(); if let t = trailing { Text(t).font(.subheadline).foregroundStyle(.secondary) } }
      .padding(.horizontal, 4)
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
