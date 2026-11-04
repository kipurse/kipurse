import SwiftUI
import AppIntents
import KipurseCore

/// A payment Siri started. Only shown for confirmation; Face ID is required on the screen; nothing is paid in the background.
struct PayDraft: Identifiable, Equatable { let id = UUID(); let amount: Int64; let payee: SiriAnswers.Payee }
@MainActor final class PayDraftCenter: ObservableObject {
  static let shared = PayDraftCenter()
  @Published var draft: PayDraft?
}

/// Snippet Siri shows with the balance answer.
struct SiriBalanceSnippet: View {
  let state: WalletState
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 4) { Text(AnswerRules.format(state.balance)).font(.system(size: 34, weight: .bold, design: .rounded)); Text("USDC").font(.headline).foregroundStyle(.secondary) }
      if let a = state.capSingle, let b = state.capDaily {
        Text(L("每笔 \(AnswerRules.format(a)) · 每天 \(AnswerRules.format(b))")).font(.subheadline).foregroundStyle(.secondary)
      }
      if let e = state.capEnd { Text(L("上限到 \(e.formatted(date: .abbreviated, time: .omitted))")).font(.caption).foregroundStyle(.secondary) }
    }.padding()
  }
}

/// Talks to the operator's /owner/pay routes. DEBUG builds can swap in a mock (UI tests; no network, no money).
struct OwnerPayClient {
  var challenge: (_ payee: String, _ amount: Int64, _ confirmNew: Bool) async throws -> (Int, [String: Any])
  var sign: (_ hash: [UInt8]) async throws -> ([UInt8], [UInt8])
  var submit: (_ id: String, _ r: [UInt8], _ s: [UInt8]) async throws -> (Int, [String: Any])
  static let live = OwnerPayClient(
    challenge: { p, a, c in try await MainnetSession.authedPost("owner/pay/challenge", ["payee": p, "amount": String(a), "confirmNewPayee": c]) },
    sign: { h in guard let k = PhoneKey.existing() else { throw MainnetSession.Failure.noKey }; return try PhoneKey.sign(h, key: k) },   // Secure Enclave: Face ID
    submit: { id, r, s in try await MainnetSession.authedPost("owner/pay/submit", ["id": id, "r": Hex.encode(r), "s": Hex.encode(s)]) })
  #if DEBUG
  /// Mock server: builds a real challenge with the phone's own formulas; "pays" without any network.
  static func mock(newPayee: Bool) -> OwnerPayClient {
    OwnerPayClient(
      challenge: { p, a, c in
        if newPayee && !c { return (409, ["error": "new_payee_needs_confirm"]) }
        let w = PhoneTrust.mainnetWallet.isEmpty ? "0x1000000000000000000000000000000000000001" : PhoneTrust.mainnetWallet, key = "0x" + String(repeating: "ab", count: 32), dl = String(Int(Date().timeIntervalSince1970) + 300)
        let ad = OwnerPay.approvalDigest(account: w, purchaseKey: key, payee: p, amount: String(a), deadline: dl)!
        return (200, ["id": "mock01", "digest": Hex.encode(PhoneTrust.walletHash(ad, wallet: w)!), "approvalDigest": Hex.encode(ad), "purchaseKey": key, "payee": p, "amount": String(a),
                      "deadline": dl, "wallet": w, "chainId": 8453, "fee": "5000", "newPayee": newPayee]) },
      sign: { _ in ([UInt8](repeating: 1, count: 32), [UInt8](repeating: 2, count: 32)) },
      submit: { _, _, _ in (200, ["ok": true, "state": "paid", "fee": "5000", "networkFee": "3000", "txHash": "0x" + String(repeating: "cd", count: 32)]) })
  }
  #endif
}

struct PayConfirmSheet: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  let draft: PayDraft
  enum Phase: Equatable { case ready, checking, blocked(String), noRoute, newPayee, paid(fee: Int64, tx: String) }
  @State private var phase: Phase = .ready
  var client: OwnerPayClient? {
    #if DEBUG
    if CommandLine.arguments.contains("-kpOwnerPayMock") { return .mock(newPayee: CommandLine.arguments.contains("-kpOwnerPayNewPayee")) }
    #endif
    return Operator.ownerPayEnabled ? .live : nil
  }
  var body: some View {
    NavigationStack {
      VStack(spacing: 22) {
        Spacer(minLength: 12)
        Avatar(name: draft.payee.name, size: 64, symbol: "person.crop.circle").assistantRef(.payee(address: draft.payee.address))
        VStack(spacing: 6) {
          Text("\(AnswerRules.format(draft.amount)) USDC").font(.system(size: 40, weight: .bold, design: .rounded)).accessibilityIdentifier("pay.amount")
          Text(L("付给 \(draft.payee.name)")).font(.headline)
          if !known || phase == .newPayee { Label(T("第一次付给这个地址", "First payment to this address"), systemImage: "exclamationmark.shield.fill").font(.caption.weight(.bold)).foregroundStyle(.white).padding(.horizontal, 10).padding(.vertical, 4).background(Capsule().fill(Brand.negative)).accessibilityIdentifier("pay.firstTime") }
          if known && phase != .newPayee { Label(T("以前付过", "Paid before"), systemImage: "checkmark.seal.fill").font(.caption.weight(.bold)).foregroundStyle(.white).padding(.horizontal, 10).padding(.vertical, 4).background(Capsule().fill(Brand.positive)).accessibilityIdentifier("pay.trusted") }
          Text(fullAddr(draft.payee.address)).font(.caption.monospaced()).fixedSize(horizontal: false, vertical: true).textSelection(.enabled).foregroundStyle(.secondary) .accessibilityIdentifier("siri.payee.full").font(.caption).padding(.horizontal, 40)
        }
        if let s = m.state, let c = s.capSingle, let d = s.capDaily, !isPaid {
          Text(L("每笔上限 \(Mainnet.whole(c)) · 今天还剩 \(Mainnet.whole(max(0, d - (s.serverSpentToday ?? 0))))")).font(.footnote).foregroundStyle(.secondary)
        }
        if !isPaid {
          // t672: protocol fee shown BEFORE Face ID (0.1%, rounded up like the contract), plus the network-fee cap.
          let fee = m.state?.protocolFee(draft.amount) ?? (draft.amount * 1000 + 999_999) / 1_000_000
          let pct = AnswerRules.percent(ppm: m.state?.capFeePpm ?? 1000)
          Group {
            if let nf = m.state?.capMaxNetworkFee { Text(L("另付手续费（\(pct)）\(AnswerRules.format(fee)) USDC · 转账费最多 \(AnswerRules.format(nf)) USDC")) }
            else { Text(T("另付手续费（\(pct)）\(AnswerRules.format(fee)) USDC · 转账费以确认页为准", "Plus a \(pct) fee of \(AnswerRules.format(fee)) USDC · transfer fee shown on the confirm page")) }
          }.font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("pay.feeBefore")
        }
        switch phase {
        case .blocked(let e): Label(e, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(Brand.negative).multilineTextAlignment(.center).padding(.horizontal, 24).accessibilityIdentifier("pay.blocked")
        case .noRoute: Label(T("没有付款：现在还不能从 App 里直接付款，钱没有动。", "Not paid: paying from the app isn't available yet. No money moved."), systemImage: "info.circle").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 24).accessibilityIdentifier("pay.noroute")
        case .newPayee:
          Label(L("这是一个新地址，以前没付过。请核对完整地址：\n\(draft.payee.address)"), systemImage: "exclamationmark.shield.fill").font(.subheadline).foregroundStyle(Brand.negative).multilineTextAlignment(.center).padding(.horizontal, 24).accessibilityIdentifier("pay.newpayee")
        case .paid(let fee, let tx):
          VStack(spacing: 6) {
            Label(L("已付款"), systemImage: "checkmark.circle.fill").font(.title3.bold()).foregroundStyle(Brand.positive).accessibilityIdentifier("pay.done")
            Text(T("手续费 \(AnswerRules.format(fee)) USDC", "Fees \(AnswerRules.format(fee)) USDC")).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("pay.fee")
            Text(shortAddr(tx)).font(.caption.monospaced()).foregroundStyle(.secondary)
          }
        default: EmptyView()
        }
        Spacer()
        if phase == .ready || phase == .checking {
          BigButton(L("用 Face ID 确认"), icon: "faceid") { Task { await confirm(newPayeeConfirmed: false) } }.padding(.horizontal, 24).accessibilityIdentifier("pay.confirm").disabled(phase == .checking)
        } else if phase == .newPayee {
          BigButton(L("地址没错，用 Face ID 付款"), icon: "faceid") { Task { await confirm(newPayeeConfirmed: true) } }.padding(.horizontal, 24).accessibilityIdentifier("pay.confirmNew")
        }
        Button(isPaid ? L("完成") : L("取消")) { dismiss() }.padding(.bottom, 12).accessibilityIdentifier("pay.cancel")
      }
      .frame(maxWidth: .infinity).background(Brand.canvas)
      .navigationTitle(L("确认付款")).navigationBarTitleDisplayMode(.inline)
    }
  }
  var isPaid: Bool { if case .paid = phase { return true }; return false }
  /// #7: payee the wallet already paid (Siri can only pick these) -> show "Trusted". Display only; the server still decides.
  var known: Bool { guard let s = m.state else { return false }; return SiriAnswers.payees(s).contains { $0.address.lowercased() == draft.payee.address.lowercased() } }
  func confirm(newPayeeConfirmed: Bool) async {
    phase = .checking
    if let s = m.state, let p = SiriAnswers.payProblem(draft.amount, s) { Haptics.error(); phase = .blocked(p); return }
    guard let client else {
      // Owner payments are off for this build: still require Face ID to show the result, move nothing.
      #if DEBUG
      let ok = m.demo != nil ? true : await BiometricGate.confirm(reason: L("付 \(AnswerRules.format(draft.amount)) USDC 给 \(draft.payee.name)"))
      #else
      let ok = await BiometricGate.confirm(reason: L("付 \(AnswerRules.format(draft.amount)) USDC 给 \(draft.payee.name)"))
      #endif
      guard ok else { phase = .ready; return }
      withAnimation { phase = .noRoute }; return
    }
    do {
      let (code, j) = try await client.challenge(draft.payee.address, draft.amount, newPayeeConfirmed)
      if code == 409, j["error"] as? String == "new_payee_needs_confirm" { Haptics.error(); withAnimation { phase = .newPayee }; return }
      guard code == 200, let c = OwnerPay.Challenge(j) else { phase = .blocked(Self.reason(j["error"] as? String, code)); return }
      // The phone recomputes what it signs from what it shows; any difference -> refuse.
      switch OwnerPay.toSign(c, wallet: PhoneTrust.mainnetWallet, payee: draft.payee.address, amount: draft.amount) {
      case .failure: Haptics.error(); phase = .blocked(L("服务器给的付款内容和屏幕上的不一致，没有确认。")); return
      case .success(let h):
        let (r, s) = try await client.sign(h)   // Secure Enclave key: Face ID prompt
        let (sc, sj) = try await client.submit(c.id, r, s)
        guard sc == 200, sj["ok"] as? Bool == true else { phase = .blocked(Self.reason(sj["error"] as? String ?? sj["state"] as? String, sc)); return }
        let fee = (Int64(sj["fee"] as? String ?? "") ?? 0) + (Int64(sj["networkFee"] as? String ?? "") ?? 0)
        Haptics.success(); withAnimation { phase = .paid(fee: fee, tx: sj["txHash"] as? String ?? "") }
        await m.refresh()
      }
    } catch { phase = .blocked((error as? LocalizedError)?.errorDescription ?? L("没有付款（\(error.localizedDescription)）")) }
  }
  static func reason(_ e: String?, _ code: Int) -> String {
    switch e {
    case "phone_needs_upgrade": return T("没有付款：请先到 设置 → Face ID 批准，点「更新」。", "Not paid: go to Settings → Face ID approvals and tap Update first.")
    case "phone_not_owner": return T("没有付款：这台 iPhone 的 Face ID 批准已关闭。", "Not paid: Face ID approvals are off for this iPhone.")
    case "over_wallet_limits": return L("没有付款，也没有让你刷 Face ID：这笔超过了钱包限额，或余额不够、钱包已暂停。可以在 App 里调高限额、充值或恢复钱包后再付。")
    case "needs_trusted_payee": return L("没有付款：这笔超过了钱包给 AI 的限额，或收款方不在信任名单里。可以在 App 里调高限额，或先把收款方加入信任名单。")
    case "owner_pay_disabled": return L("没有付款：服务器没有开通从 App 付款。")
    case "invalid_session": return L("没有付款：请先用 Face ID 打开钱包。")
    default: return T("没有付款。", "Not paid. ") + ServerText.text(code: e, status: code)
    }
  }
}
