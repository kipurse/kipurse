import SwiftUI
import KipurseCore

/// Animated "watch how" tutorial per AI client: a mini mock of the client's screen, steps auto-advance with a moving highlight.
/// Tap = next step, long-press = pause. Pure SwiftUI, no video assets, respects Reduce Motion.
struct ConnectTutorial: View {
  struct Scene: Identifiable { let id = UUID(); let icon: String; let screen: String; let tap: String; let caption: String }
  let clientId: String
  @State private var i = 0
  @State private var paused = false
  @State private var pulse = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let timer = Timer.publish(every: 2.6, on: .main, in: .common).autoconnect()

  static func scenes(_ id: String) -> [Scene] {
    switch id {
    case "chatgpt": return [
      Scene(icon: "gearshape", screen: "ChatGPT › " + T("设置", "Settings"), tap: T("连接器", "Connectors"), caption: T("打开 ChatGPT → 设置 → 连接器", "Open ChatGPT → Settings → Connectors")),
      Scene(icon: "plus.circle", screen: T("连接器", "Connectors"), tap: T("创建", "Create"), caption: T("点「创建」，粘贴 Kipurse 地址", "Tap Create and paste your Kipurse address")),
      Scene(icon: "faceid", screen: "Kipurse", tap: T("批准", "Approve"), caption: T("手机上弹出通知 → Face ID 批准", "Your iPhone buzzes → approve with Face ID")),
      Scene(icon: "checkmark.seal", screen: "ChatGPT", tap: T("已连接", "Connected"), caption: T("回到 ChatGPT：说「查一下我的 Kipurse」", "Back in ChatGPT, say “check my Kipurse”"))]
    case "claude-desktop", "claude": return [
      Scene(icon: "gearshape", screen: "Claude › " + T("设置", "Settings"), tap: T("连接器", "Connectors"), caption: T("打开 Claude → 设置 → 连接器", "Open Claude → Settings → Connectors")),
      Scene(icon: "plus.circle", screen: T("连接器", "Connectors"), tap: T("添加自定义连接器", "Add custom connector"), caption: T("名字填 Kipurse，粘贴地址，其他留空", "Name it Kipurse, paste the address, leave the rest empty")),
      Scene(icon: "faceid", screen: "Kipurse", tap: T("批准", "Approve"), caption: T("在手机上用 Face ID 批准", "Approve on your iPhone with Face ID")),
      Scene(icon: "checkmark.seal", screen: "Claude", tap: T("已连接", "Connected"), caption: T("在对话里打开 Kipurse 工具就能用了", "Turn on the Kipurse tools in a chat — done"))]
    case "muse": return [
      Scene(icon: "doc.on.doc", screen: "Kipurse", tap: T("一键复制给 Muse", "Copy for Muse"), caption: T("点「一键复制给 Muse」", "Tap “Copy for Muse”")),
      Scene(icon: "bubble.left.and.text.bubble.right", screen: "Muse", tap: T("粘贴并发送", "Paste & send"), caption: T("在 Muse 对话里粘贴发送，就这一步", "Paste it into a Muse chat and send — that's it")),
      Scene(icon: "checkmark.seal", screen: "Muse", tap: T("已连接", "Connected"), caption: T("Muse 会回复你的钱包余额", "Muse replies with your wallet balance"))]
    case "grok": return [
      Scene(icon: "gearshape", screen: "Grok › " + T("设置", "Settings"), tap: T("连接", "Connections"), caption: T("打开 Grok → 设置 → 连接", "Open Grok → Settings → Connections")),
      Scene(icon: "plus.circle", screen: T("连接", "Connections"), tap: T("添加连接", "Add MCP"), caption: T("粘贴 Kipurse 地址", "Paste your Kipurse address")),
      Scene(icon: "faceid", screen: "Kipurse", tap: T("批准", "Approve"), caption: T("Face ID 批准就连上了", "Approve with Face ID — connected"))]
    case "cursor": return [
      Scene(icon: "arrow.up.forward.app", screen: "Kipurse", tap: T("在 Cursor 里安装", "Install in Cursor"), caption: T("在电脑上点「在 Cursor 里安装」", "On your computer, tap “Install in Cursor”")),
      Scene(icon: "checkmark.circle", screen: "Cursor", tap: T("安装", "Install"), caption: T("Cursor 弹窗里点「安装」", "Click Install in Cursor")),
      Scene(icon: "checkmark.seal", screen: "Cursor", tap: T("已连接", "Connected"), caption: T("在 Agent 里说「查一下我的 Kipurse」", "In Agent, say “check my Kipurse”"))]
    default: return [
      Scene(icon: "doc.on.doc", screen: "Kipurse", tap: T("一键复制配置", "Copy setup"), caption: T("点「一键复制配置」", "Tap “Copy setup”")),
      Scene(icon: "square.and.pencil", screen: T("你的 AI", "Your AI"), tap: "MCP", caption: T("粘贴到 AI 的连接设置里", "Paste it into your AI's MCP settings")),
      Scene(icon: "checkmark.seal", screen: T("你的 AI", "Your AI"), tap: T("已连接", "Connected"), caption: T("说「查一下我的 Kipurse」验证", "Say “check my Kipurse” to test"))]
    }
  }

  var body: some View {
    let sc = Self.scenes(clientId)
    let s = sc[min(i, sc.count - 1)]
    VStack(spacing: 14) {
      // mini mock screen
      VStack(spacing: 10) {
        HStack { Text(s.screen).font(.caption.weight(.semibold)).foregroundStyle(.secondary); Spacer() }
        RoundedRectangle(cornerRadius: 6).fill(Color(uiColor: .tertiarySystemFill)).frame(height: 10)
        RoundedRectangle(cornerRadius: 6).fill(Color(uiColor: .tertiarySystemFill)).frame(width: 140, height: 10).frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 8) {
          Image(systemName: s.icon)
          Text(s.tap).font(.subheadline.weight(.semibold))
        }
        .foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 10)
        .background(Brand.accent, in: Capsule())
        .scaleEffect(pulse && !reduceMotion ? 1.06 : 1.0)
        .overlay(alignment: .bottomTrailing) {
          Image(systemName: "hand.point.up.left.fill").font(.title3).foregroundStyle(.primary)
            .offset(x: 18, y: pulse && !reduceMotion ? 14 : 22).opacity(0.85)
        }
      }
      .padding(16).frame(maxWidth: .infinity)
      .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .id(i).transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
      Text("\(i + 1). " + s.caption).font(.subheadline.weight(.medium)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 6) {
        ForEach(0..<sc.count, id: \.self) { k in Capsule().fill(k <= i ? Brand.accent : Color(uiColor: .tertiarySystemFill)).frame(height: 4) }
      }
      Text(paused ? T("已暂停 · 点一下继续", "Paused · tap to continue") : T("点一下看下一步", "Tap for the next step")).font(.caption).foregroundStyle(.secondary)
    }
    .contentShape(Rectangle())
    .onTapGesture { paused = false; advance(sc.count) }
    .onLongPressGesture { paused = true }
    .onReceive(timer) { _ in if !paused { advance(sc.count) } }
    .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true } }
    .accessibilityElement(children: .combine).accessibilityLabel(s.caption)
  }
  private func advance(_ n: Int) { withAnimation(Brand.spring) { i = (i + 1) % n } }
}
