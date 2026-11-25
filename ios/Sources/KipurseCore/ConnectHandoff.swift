import Foundation

/// t1254 (decision 123): the "next step" page shown after "[zh]" on the first-connect limits page, BEFORE the app jumps to an
/// outside AI (Muse or another agent app). It says plainly that the limits are not in effect yet and where the one Face ID
/// confirmation will happen. Display only: nothing here saves, grants or signs.
public enum ConnectHandoff {
  public enum Kind: Equatable { case muse, prefill, paste }

  public static func title(_ name: String) -> String { T("下一步：去 \(name) 完成连接", "Next: finish connecting in \(name)") }

  /// The amounts the owner just typed, with the fact that they are only staged on this phone.
  public static func staged(single: Int64, daily: Int64, term: Int64) -> String {
    let s = MoneyText.usdc(single), d = MoneyText.usdc(daily), t = MoneyText.usdc(term)
    return T("你刚填的限额：每笔 \(s)，每天 \(d)，总额 \(t)。\n现在还没生效，只暂存在这台手机上。",
             "The limits you just set: \(s) per payment, \(d) per day, \(t) in total.\nThey are not in effect yet; they are only kept on this phone.")
  }

  public static func steps(_ name: String, kind: Kind) -> [String] {
    let back = T("\(name) 会发来一个登录链接，点它回到启付", "\(name) sends a sign-in link; tap it to come back to Kipurse")
    let confirm = T("在启付核对限额和连接，用 Face ID 批准一次，这时才生效", "In Kipurse, check the limits and the connection and approve once with Face ID. Only then is it in effect")
    switch kind {
    case .muse:
      return [T("点下面的按钮：连接文字会自动复制，并打开 Muse", "Tap the button below: the connect text is copied and Muse opens"),
              T("在 Muse 对话框里长按，点「粘贴」，再点发送", "In the Muse chat, long-press, tap Paste, then send"),
              back, confirm]
    case .prefill:
      return [T("点下面的按钮打开 \(name)，连接文字已经填好", "Tap the button below to open \(name); the connect text is already filled in"),
              T("在 \(name) 里点发送", "Tap send in \(name)"), back, confirm]
    case .paste:
      return [T("点下面的按钮：连接文字会自动复制，并打开 \(name)", "Tap the button below: the connect text is copied and \(name) opens"),
              T("在 \(name) 里粘贴并发送", "Paste it in \(name) and send"), back, confirm]
    }
  }

  public static func button(_ name: String, kind: Kind) -> String {
    kind == .prefill ? T("打开 \(name)", "Open \(name)") : T("复制并打开 \(name)", "Copy and open \(name)")
  }
  public static let later = T("先不连", "Not now")
  public static let nothingYet = T("还没有任何 AI 能用你的钱包。", "No AI can use your wallet yet.")
}
