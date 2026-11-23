import KipurseCore
/// Demo state for the Siri module's self-test (lets App/Assistant reach the app's sample data without knowing AppModel).
enum AppModelDemo { @MainActor static func mainState() -> WalletState { AppModel.demoState("main") } }
