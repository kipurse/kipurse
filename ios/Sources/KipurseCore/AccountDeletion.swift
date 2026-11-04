import Foundation

/// Account deletion: the confirm phrase, the step order, and the L("离线提现指南") guide built from the server's recovery package.
/// Pure (no UI), so it is unit-tested. Methods listed here are only the ones that work for the V5 contracts (see docs/ACCOUNT_DELETION.md).
public enum AccountDeletion {
  public static let phrase = L("删除我的账户")
  public enum Step: Int, CaseIterable { case overview, withdrawFirst, typePhrase, faceID, countdown, done }
  public static let countdownSeconds = 10
  /// Exact phrase only (surrounding spaces are ignored; no fuzzy match).
  public static func phraseOK(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines) == phrase }
  public static func next(_ s: Step) -> Step { Step(rawValue: s.rawValue + 1) ?? .done }
}

public struct RecoveryGuide: Codable, Equatable {
  public struct Method: Codable, Equatable { public let id: String, title: String, works: Bool, needsGas: String, steps: [String]; public var advanced: Bool? = nil }
  public let createdAt: Date
  public let network: String, chainId: Int, explorer: String
  public let wallet: String, owner: String, usdc: String, spendPermissionManager: String, adapter: String
  public let payerVault: String?, floatVault: String?
  public let balanceAtDeletion: Int64
  public let permissionStillValid: Bool
  public let revokeTo: String?, revokeData: String?
  public let permissionJSON: String?
  public let methods: [Method]
  /// One-tap L("离线提现") page link (the rescue card rides in the #fragment; no Kipurse server needed).
  public let rescueUrl: String?
  public var simpleMethods: [Method] { methods.filter { $0.advanced != true } }
  public var advancedMethods: [Method] { methods.filter { $0.advanced == true } }

  /// From the deleteAccount response `recovery` object (kit/server.mjs recoveryInfo()).
  public init?(recovery r: JSONValue, now: Date = Date()) {
    guard let w = r["wallet"]?.string, let o = r["owner"]?.string else { return nil }
    createdAt = now; wallet = w; owner = o
    chainId = Int(r["chainId"]?.atomic ?? 84532); network = r["network"]?.string ?? (chainId == 8453 ? "Base" : "Base Sepolia (test)")
    explorer = r["explorer"]?.string ?? (chainId == 8453 ? "https://basescan.org" : "https://sepolia.basescan.org")
    usdc = r["usdc"]?.string ?? ""; spendPermissionManager = r["spendPermissionManager"]?.string ?? "0xf85210B21cC50302F477BA56686d2019dC9b67Ad"
    adapter = r["adapter"]?.string ?? ""; payerVault = r["payerVault"]?.string; floatVault = r["floatVault"]?.string
    balanceAtDeletion = (r["balances"]?["wallet"]?.atomic ?? 0) + (r["balances"]?["vault"]?.atomic ?? 0)
    permissionStillValid = r["permissionValid"]?.bool ?? (r["permissionValid"] == nil)
    revokeTo = r["revoke"]?["to"]?.string; revokeData = r["revoke"]?["data"]?.string
    if let p = r["permission"], p != .null, let d = try? JSONEncoder().encode(["permission": p]) { permissionJSON = String(data: d, encoding: .utf8) } else { permissionJSON = nil }
    rescueUrl = r["rescueUrl"]?.string
    methods = RecoveryGuide.methods(wallet: w, owner: o, usdc: usdc, spm: spendPermissionManager, vault: payerVault, explorer: explorer, revokeKnown: revokeData != nil, rescueUrl: rescueUrl)
  }

  static func methods(wallet: String, owner: String, usdc: String, spm: String, vault: String?, explorer: String, revokeKnown: Bool, rescueUrl: String? = nil) -> [Method] {
    let spmBytes = "0x000000000000000000000000" + spm.lowercased().dropFirst(2)
    let a: [Method] = [
      Method(id: "rescue", title: L("一键提现（推荐，普通人用这个）"), works: true, needsGas: L("不需要我们的服务器。手续费不到 0.01 美元，在 Coinbase 确认窗口里用 USDC 付，不需要 ETH"),
        steps: [L("打开「离线提现」网页（本页的链接 / 二维码，或 App 设置里的按钮）。"),
                L("点「用 Coinbase 登录」，用你设置 Kipurse 时的那个 Base / Coinbase 账户（\(owner)）。"),
                L("点「全部提现」，在弹窗里确认一次。钱会全部回到这个账户，Base App / Coinbase 里直接能看到；也可以填你 Coinbase 的 USDC 地址（网络选 Base）。"),
                L("完成后 AI 再也不能用这个钱包付款。")] + (rescueUrl.map { [L("链接：\($0)")] } ?? [])),
      Method(id: "exit-kit", title: L("高级：开源退出工具（技术人员用）"), works: true, needsGas: L("需要：你的 Coinbase 钱包付一点手续费"),
        steps: [L("打开开源的单文件退出工具 exit-kit.html（可以离线保存在手机或电脑上，不依赖我们的服务器）。"),
                L("网络选 \(explorer.contains("sepolia") ? "Base Sepolia" : T("Base 网络", "Base mainnet"))，填你的钱包地址 \(wallet)。"),
                L("“载入救援卡”：粘贴本页最后的授权 JSON（没有也行，工具可以扫链上日志找回）。"),
                L("用 Coinbase 钱包连接（要用设置时的那个账户 \(owner)）。"),
                L("点“全部执行”：撤销授权 + 移除 SpendPermissionManager（kill switch）+ 关闭小额预付 + 扫回结算账户 + 全额转到你的地址。"),
                L("等回执显示成功，钱包余额变成 0。")], advanced: true),
      Method(id: "basescan", title: L("高级：区块浏览器（Basescan）写合约"), works: true, needsGas: L("需要：你的 owner 钱包付 ETH gas；每一步一笔交易"),
        steps: [L("打开 \(explorer)/address/\(wallet)#writeProxyContract，用 owner 钱包 “Connect to Web3”（注意：通行密钥 Coinbase 钱包能否连上 Basescan 我们没测过；连不上就用一键提现）。"),
                L("Kill switch：Read 里确认 ownerAtIndex(1) 等于 \(spmBytes)；然后 Write 调用 removeOwnerAtIndex(index=1, owner=\(spmBytes))。之后任何授权都不能再动钱。"),
                vault.map { L("（如结算账户还有钱）execute(target=\($0), value=0, data=0x35faa416) —— 调用 sweep() 把结算账户的钱扫回钱包。") } ?? L("没有结算账户，跳过这一步。"),
                L("在 \(explorer)/token/\(usdc)#readProxyContract 读 balanceOf(\(wallet)) 得到余额 A（6 位小数的整数）。"),
                L("execute(target=\(usdc), value=0, data=0xa9059cbb + 你的地址补零到 32 字节 + A 的 32 字节十六进制) —— 把 A 转到你自己的地址。"),
                revokeKnown ? L("（可选，kill switch 之后不是必须）用本页末尾的撤销数据：向钱包地址发送那段 data，撤销链上授权。") : L("（可选）撤销授权需要授权数据，用退出工具扫日志更方便。")], advanced: true),
    ]
    return a
  }

  /// Plain text version (also the source of the PDF).
  public var text: String {
    var t = [L("离线提现指南"), L("生成时间：\(ISO8601DateFormatter().string(from: createdAt))"), "",
             L("你的账户已删除，但钱没有被删除。USDC 一直在链上你自己的智能钱包里，只有你的 Coinbase 钱包 能控制；我们的服务器已经删掉了所有数据和 AI 的执行密钥，不能再动它。"), "",
             L("最简单：打开「离线提现」网页，用同一个 Coinbase 钱包登录，按一下「全部提现」。") + (rescueUrl.map { "\n" + $0 } ?? ""), "",
             L("网络：\(network)（chainId \(chainId)）"), L("钱包地址：\(wallet)"), L("你的 Coinbase 钱包（主人）：\(owner)"),
             L("删除时余额：\(AnswerRules.format(balanceAtDeletion)) USDC"), L("USDC 合约：\(usdc)"), "SpendPermissionManager" + T("：", ": ") + spendPermissionManager, L("Kipurse 适配器：\(adapter)")]
    if let v = payerVault { t.append(L("结算账户（payer vault）：\(v)")) }
    if let f = floatVault { t.append(L("小额预付（float vault）：\(f)")) }
    t += ["", permissionStillValid ? L("⚠️ 链上授权还没有撤销。没人能再用它（执行密钥已销毁），但建议按下面任一方法撤销或用 kill switch。") : L("✅ 链上授权已撤销。"), ""]
    for m in methods { if m.advanced == true && m.id == "exit-kit" { t.append(L("—— 以下是给技术人员的备用方法 ——")) }; t.append(T("【\(m.title)】", "[\(m.title)]") + (m.works ? "" : L("（不可用）"))); if m.works { t.append(m.needsGas) }; for (i, s) in m.steps.enumerated() { t.append("\(i + 1). \(s)") }; t.append("") }
    if let to = revokeTo, let d = revokeData { t += [L("撤销授权的交易（从 owner 发给 \(to)）："), d, ""] }
    if let p = permissionJSON { t += [L("授权数据（救援卡，给退出工具用）："), p] }
    return t.joined(separator: "\n")
  }
}
