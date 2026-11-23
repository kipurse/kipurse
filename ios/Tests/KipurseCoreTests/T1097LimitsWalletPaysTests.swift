import XCTest
@testable import KipurseCore

final class T1097LimitsWalletPaysTests: XCTestCase {
  func testSenderIsTheKipurseWalletOnlyOnTheNewPath() {
    XCTAssertEqual(UsdcGas.limitsSender(owner: "0xaaa", wallet: "0xbbb", fromWallet: true), "0xbbb")
    XCTAssertEqual(UsdcGas.limitsSender(owner: "0xaaa", wallet: "0xbbb", fromWallet: false), "0xaaa")
  }
  func testPaymasterMethodAllowlistAndAddresses() {
    XCTAssertTrue(UsdcGas.paymasterMethodAllowed("pm_getPaymasterStubData"))
    XCTAssertTrue(UsdcGas.paymasterMethodAllowed("pm_getPaymasterData"))
    XCTAssertTrue(UsdcGas.paymasterMethodAllowed("pimlico_getTokenQuotes"))
    XCTAssertFalse(UsdcGas.paymasterMethodAllowed("eth_sendTransaction"))
    XCTAssertFalse(UsdcGas.paymasterMethodAllowed("pm_sponsorUserOperation"))
    XCTAssertEqual(UsdcGas.erc20Paymaster.lowercased(), "0x6666666666667849c56f2850848ce1c4da65c68b")
    XCTAssertEqual(UsdcGas.entryPointV06.lowercased(), "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789")
    XCTAssertEqual(UsdcGas.baseUSDC.lowercased(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")
  }
  func testFeeCapAndInsufficientBalanceBlockConfirm() {
    XCTAssertNil(UsdcGas.limitsFeeBlock(fee: 9_999, wallet: 9_999))
    XCTAssertEqual(UsdcGas.limitsFeeBlock(fee: 10_000, wallet: 1_000_000), "fee_above_cap")
    XCTAssertEqual(UsdcGas.limitsFeeBlock(fee: 100, wallet: 99), UsdcGas.insufficientCode)
    XCTAssertEqual(UsdcGas.limitsFeeBlock(fee: 100, wallet: nil), UsdcGas.insufficientCode)
    XCTAssertEqual(UsdcGas.insufficientCode, "kipurse_balance_insufficient_for_fee")
    XCTAssertEqual(UsdcGas.approveCapAtomic, 50_000)
    XCTAssertTrue(UsdcGas.approveTargetAllowed(UsdcGas.erc20Paymaster))
    XCTAssertFalse(UsdcGas.approveTargetAllowed("0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c"))
  }
  func testDialogCopy() {
    XCTAssertEqual(UsdcGas.feeDialog(usdc: "0.006"), "修改钱包安全上限需要一点网络费（约 0.006 USDC），从启付余额里扣")
    XCTAssertEqual(UsdcGas.insufficientZH, "启付余额不足以支付网络费")
  }
}
