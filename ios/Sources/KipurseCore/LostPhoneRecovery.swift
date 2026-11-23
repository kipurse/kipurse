import Foundation

/// t1045u: recovery starts at a public URL, with only the original Coinbase wallet; no saved link is required.
public enum LostPhoneRecovery {
  public static var title: String { T("手机丢了怎么办", "Lost your phone?") }
  public static var subtitle: String { T("换台设备，连接同一个 Coinbase 自动找回；Coinbase 钱包需留一点 USDC", "Recover automatically on another device with the same Coinbase wallet; keep a little USDC in your Coinbase wallet") }
  public static var intro: String { T("手机丢了，或现在登不上启付？先别慌：钱在你自己的钱包里，不在手机里。下面用电脑或另一部手机操作，不需要打开原来的启付 App。平时还能打开启付时，直接用「钱包」页的「提现」。", "Lost your phone or cannot sign in to Kipurse? Your money is in your own wallet, not on the phone. Follow these steps on a computer or another phone without opening the old Kipurse app. For everyday withdrawals when Kipurse still opens, use Withdraw on the Wallet tab.") }
  public static var steps: [String] {
    [T("找一台你信得过的电脑，或另一部手机。不需要拿回丢失的手机，也不用先装启付。", "Use a computer you trust or another phone. You do not need the lost phone and do not have to install Kipurse first."),
     T("打开 Coinbase 或 Base App；用电脑时可打开 keys.coinbase.com。登录当时连接启付的同一个 Coinbase 钱包，不要另建新钱包。若你连 Coinbase 也登不上，先按 Coinbase 的官方指引找回登录方式，再继续。", "Open Coinbase or the Base App; on a computer you can open keys.coinbase.com. Sign in to the same Coinbase wallet you connected to Kipurse, not a new wallet. If you cannot sign in to Coinbase either, recover access using Coinbase’s official instructions before continuing."),
     T("在这个 Coinbase 钱包里留一点 USDC（大约 1 美元就够）。手续费不到 0.01 美元，从 Coinbase 钱包扣，不从启付余额扣；不是要花掉整整 1 美元。不够时，先往这个钱包转一点 USDC，网络选 Base。", "Keep a little USDC in that Coinbase wallet (about $1 is enough). The fee is under $0.01 and comes from Coinbase, not your Kipurse balance; you do not spend the whole $1. If needed, transfer a little USDC to this wallet and choose the Base network."),
     T("在电脑或另一部手机的浏览器里打开 https://kipurse.github.io/rescue/，点「连接同一个 Coinbase 钱包」。用原来的钱包登录后，页面会自动找到你的启付钱包和可取回的金额。", "In a browser on a computer or another phone, open https://kipurse.github.io/rescue/ and tap “Connect the same Coinbase wallet”. Sign in with the original wallet; the page automatically finds your Kipurse wallet and the amount you can recover."),
     T("核对要取回的金额和你的 Coinbase 钱包，再用同一个 Coinbase 钱包确认。钱只能回到你本人，不能改给别人。Coinbase 显示确认成功后，通常几秒就能在这个钱包里看到。不要把密码、验证码或恢复资料交给别人。", "Check the amount and your Coinbase wallet, then confirm with that same wallet. The money can only go back to you, not to someone else. After Coinbase confirms success, it usually appears in that wallet within seconds. Never give anyone your password, codes or recovery information.")]
  }
  public static var feeNote: String { T("两处的钱是分开的：启付里的钱会取回到你的 Coinbase 钱包；那一点点网络手续费，用 Coinbase 钱包里原有的 USDC 付，不从启付余额扣。", "The two balances are separate: your money moves from Kipurse back to your Coinbase wallet. The small network fee is paid with USDC already in Coinbase, not from your Kipurse balance.") }
  public static var publicPageNote: String { T("不用找旧手机，也不用截图、备份链接或 PDF。只要能登录原来的同一个 Coinbase 钱包，就能在上面的网址取回。不要把密码、验证码或恢复资料交给任何人。", "You do not need the old phone, screenshots, saved links or a PDF. Access to the original Coinbase wallet is all you need to recover at the URL above. Never give anyone your password, codes or recovery information.") }
  public static var appFallbackTitle: String { T("你现在这台还能打开启付时的备用", "Backup: this device can still open Kipurse") }
}
