import SwiftUI
import KipurseCore
/// Handbook 0B (owner t1010u): 使用指引, four steps, existing design system only (PageTitle, .card(), KPNotice, Brand).
/// §6#110: below the steps, links to 手机丢了怎么办 and 安全小贴士 (existing LimitEntryRow cards).
struct UsageGuideView: View {
  var current: Int = 1
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: KP.Space.l) {
        PageTitle(eyebrow: nil, title: T("使用指引", "How to start"), id: "guide.title")
        Text(T("一步一步开户。所有页面你都可以先随便看。", "Open your account step by step. You can look around every page first.")).font(KP.Typo.body).foregroundStyle(.secondary)
        ForEach(UsageGuide.steps, id: \.n) { st in
          let done = st.n < current, now = st.n == current
          HStack(alignment: .top, spacing: KP.Space.s) {
            Image(systemName: done ? "checkmark.circle.fill" : "\(st.n).circle.fill").font(.title2).foregroundStyle(done ? Brand.positive : now ? Brand.accent : .secondary)
            VStack(alignment: .leading, spacing: KP.Space.xxs) {
              Text(T("第 \(st.n) 步：", "Step \(st.n): ") + T(st.zh, st.en)).font(KP.Typo.cardTitle)
              Text(T(st.detailZh, st.detailEn)).font(KP.Typo.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
          }.frame(maxWidth: .infinity, alignment: .leading).card().accessibilityElement(children: .combine).accessibilityIdentifier("guide.step\(st.n)")
        }
        // §6#110 (owner 2026-11-21): the guide also holds 手机丢了怎么办 and 安全小贴士 (not extra steps: 0B keeps exactly four).
        VStack(alignment: .leading, spacing: KP.Space.headGap) {
          SectionHead(title: T("更多帮助", "More help"))
          VStack(spacing: KP.Space.cardGap) {
            NavigationLink { LostPhoneGuide() } label: {
              LimitEntryRow(icon: "iphone.slash", title: LostPhoneRecovery.title, sub: T("换新手机、取回钱包里的钱，一步一步来。", "Get a new phone and get your money back, step by step."))
            }.buttonStyle(.plain).accessibilityIdentifier("guide.lostPhone")
            NavigationLink { SafetyTipsView() } label: {
              LimitEntryRow(icon: "checkmark.shield", title: T("安全小贴士", "Safety tips"), sub: T("防骗、暂停 AI 付款、手续费，\(SafetyTips.zh.count) 条要点。", "Scams, pausing AI payments and fees: \(SafetyTips.en.count) key points."))
            }.buttonStyle(.plain).accessibilityIdentifier("guide.tips")
          }
        }.padding(.top, KP.Space.s)
      }.padding(.horizontal, KP.Space.page).padding(.bottom, 132)
    }.background(MockBG()).navigationBarTitleDisplayMode(.inline)   // t1245 U28: one page title (no repeated bar title), like the other help pages
  }
}
