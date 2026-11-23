// t1214 (handbook §6#101/#102): developer/test build ONLY. This whole file compiles only with KP_DEV_MIGRATION (set for the Debug config in
// project.yml); the Release/public App has no contract-migration page, no entry, no strings. Owner: 「用户的软件，绝对不能有换合约页面」.
#if KP_DEV_MIGRATION
import SwiftUI
import KipurseCore

/// Phone-side checks of a /migrate-v54/plan reply before anything opens: it is for MY wallet and MY Base Account, every call goes only through
/// my wallet / the deployer / the adapter, the fee is small, and the labels match the calls. The page then refuses any batch that differs by one byte (KPVH #vh=).
enum DevMigrationCheck {
  static let maxFee: UInt64 = 100_000   // 0.10 USDC
  /// Only on the developer's own wallet (never in demo / screenshot runs); UI tests opt in with -kpDevMigration.
  /// The developer wallet comes from Info.plist KipurseDevWallet (KIPURSE_DEV_WALLET in the private Config/Local.xcconfig); empty = nobody.
  static var devWallet: String {
    let v = ((Bundle.main.object(forInfoDictionaryKey: "KipurseDevWallet") as? String) ?? "").trimmingCharacters(in: .whitespaces).lowercased()
    return v.count == 42 && v.hasPrefix("0x") ? v : ""
  }
  static var visible: Bool { (!devWallet.isEmpty && Operator.wallet.lowercased() == devWallet) || ProcessInfo.processInfo.arguments.contains("-kpDevMigration") }
  static func problems(_ p: [String: Any], wallet: String, owner: String) -> [String] {
    var out: [String] = []; func lc(_ s: String?) -> String { (s ?? "").lowercased() }
    if lc(p["wallet"] as? String) != lc(wallet) { out.append("wallet") }
    if lc(p["owner"] as? String) != lc(owner) { out.append("owner") }
    if lc(p["adapterV54"] as? String) != lc(KipurseSuite.v54.adapter) { out.append("adapter") }
    guard let calls = p["calls"] as? [[String: Any]], !calls.isEmpty else { return out + ["calls"] }
    // only my wallet, the CREATE2 deployer (phone approver V4), the V5.4 adapter, and for a rollback the V5.2 adapter (same list as the box checker)
    let allowed: [String] = [wallet, "0x4e59b44847b379578588920cA78FbF26c0B4956C", KipurseSuite.v54.adapter] + ((p["mode"] as? String) == "rollback" ? [KipurseSuite.v52.adapter] : [])
    let ok = Set(allowed.map { $0.lowercased() })
    if calls.contains(where: { !ok.contains(lc($0["to"] as? String)) }) { out.append("call target") }
    if calls.contains(where: { let v = lc($0["value"] as? String); return !(v.isEmpty || v == "0x0" || v == "0x00" || v == "0") }) { out.append("value") }
    if (p["labels"] as? [String])?.count != calls.count { out.append("labels") }
    guard let f = UInt64(p["fee"] as? String ?? ""), f <= maxFee else { return out + ["fee"] }
    return out
  }
}

struct DevMigrationView: View {
  @State private var mode = "migrate"
  @State private var plan: [String: Any]? = nil
  @State private var state = ""
  @State private var page: WebSheet? = nil
  var body: some View {
    List {
      Section { Picker("", selection: $mode) { Text("V5.2 → V5.4").tag("migrate"); Text(T("回滚到 V5.2", "Roll back to V5.2")).tag("rollback") }.pickerStyle(.segmented) }
        footer: { Text(T("仅开发者测试版。你的 Base 账户确认一次；手续费用 USDC 从启付钱包付。", "Developer test build only. Your Base Account confirms once; the fee is paid in USDC from the Kipurse wallet.")) }
      if let p = plan {
        Section(T("这次会做", "This will")) { ForEach(Array(((p["labels"] as? [String]) ?? []).enumerated()), id: \.offset) { Text($0.element).font(.footnote.monospaced()) } }
        Section { HStack { Text(T("手续费", "Fee")); Spacer(); Text("\((Double(p["fee"] as? String ?? "0") ?? 0) / 1e6) USDC") }
          if (p["vaultSeed"] as? String ?? "0") != "0" { HStack { Text(T("放进你的付款保险箱", "Into your payer vault")); Spacer(); Text("\((Double(p["vaultSeed"] as? String ?? "0") ?? 0) / 1e6) USDC") } } }
        Section { Button(T("打开确认页", "Open the confirm page")) { open(p) }.accessibilityIdentifier("devmig.open") }
      }
      if !state.isEmpty { Section { Text(state).foregroundStyle(.secondary) } }
      Section { Button(T("读取方案", "Load the plan")) { Task { await load() } }.accessibilityIdentifier("devmig.load") }
    }.navigationTitle("V5.4 (dev)").accessibilityIdentifier("devmig.screen")
      .sheet(item: $page) { w in SignPage(url: w.url).ignoresSafeArea() }
      .onChange(of: mode) { _ in plan = nil; state = "" }
  }
  func load() async {
    plan = nil; state = T("正在读取…", "Loading…")
    guard var c = URLComponents(url: Mainnet.base.appendingPathComponent("migrate-v54/plan"), resolvingAgainstBaseURL: false) else { return }
    c.queryItems = [URLQueryItem(name: "mode", value: mode)]
    guard let u = c.url, let (d, _) = try? await URLSession.shared.data(from: u), let p = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { state = T("读取失败。", "Couldn't load it."); return }
    if let e = p["error"] as? String { state = T("现在不能做：", "Not possible now: ") + e + " " + ((p["block"] as? [String]) ?? []).joined(separator: ", "); return }
    guard let owner = Operator.ownerAccount else { state = T("找不到你的 Base 账户。", "Your Base Account isn't known."); return }
    let bad = DevMigrationCheck.problems(p, wallet: Operator.wallet, owner: owner)
    if !bad.isEmpty { state = T("方案和手机检查不一致，已停止：", "The plan failed the phone's checks, stopped: ") + bad.joined(separator: ", "); return }
    plan = p; state = ""
  }
  func open(_ p: [String: Any]) {
    guard let owner = Operator.ownerAccount, let link = URL(string: p["link"] as? String ?? ""), link.host == Mainnet.base.host,
          let calls = (p["calls"] as? [[String: Any]])?.map({ $0.compactMapValues { $0 as? String } }),
          let cu = BatchVerify.committedURL(link, chainId: 8453, from: owner, calls: calls) else { state = T("打不开确认页。", "Couldn't open the confirm page."); return }
    page = WebSheet(url: cu)
    let m = mode, w = Operator.wallet
    Task { @MainActor in for _ in 0..<60 { try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard let (d, _) = try? await URLSession.shared.data(from: Mainnet.base.appendingPathComponent("migrate-v54/status")), let s = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
      if m == "migrate", (s["migrated"] as? Bool) == true { KipurseSuite.remember(.v54, wallet: w); state = T("✅ 已切换到 V5.4。", "✅ Switched to V5.4."); plan = nil; return }
      if m == "rollback", (s["rolledBack"] as? Bool) == true { KipurseSuite.remember(.v52, wallet: w); state = T("✅ 已回到 V5.2。", "✅ Back on V5.2."); plan = nil; return } } }
  }
}
#endif
