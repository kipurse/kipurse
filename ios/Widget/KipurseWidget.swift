import WidgetKit
import SwiftUI
#if canImport(ActivityKit)
import ActivityKit
#endif

struct SpendEntry: TimelineEntry { let date: Date; let s: SharedSpend.Snapshot? }
struct SpendProvider: TimelineProvider {
  func placeholder(in c: Context) -> SpendEntry { SpendEntry(date: Date(), s: .init(balance: 25_000_000, spentToday: 6_500_000, dailyLimit: 10_000_000, lastAgent: "Codex", lastAmount: 5_500_000, lastAt: Date(), paymentsToday: 3, pending: 0, chinese: false, updated: Date())) }
  func getSnapshot(in c: Context, completion: @escaping (SpendEntry) -> Void) { completion(SpendEntry(date: Date(), s: SharedSpend.load() ?? placeholder(in: c).s)) }
  func getTimeline(in c: Context, completion: @escaping (Timeline<SpendEntry>) -> Void) {
    completion(Timeline(entries: [SpendEntry(date: Date(), s: SharedSpend.load())], policy: .after(Date().addingTimeInterval(15 * 60)))) }
}
struct SpendWidgetView: View {
  let e: SpendEntry; @Environment(\.widgetFamily) var family
  var body: some View {
    let zh = (Locale.preferredLanguages.first ?? "en").lowercased().hasPrefix("zh")   // follow the iPhone language
    VStack(alignment: .leading, spacing: 6) {
      Text(zh ? "AI 今天花了" : "AI spent today").font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.85))
      Text(SharedSpend.fmt(e.s?.spentToday ?? 0, zh)).font(.system(size: 28, weight: .bold, design: .rounded)).foregroundStyle(.white).minimumScaleFactor(0.6)
      if let s = e.s, s.dailyLimit > 0 { ProgressView(value: Double(min(s.spentToday, s.dailyLimit)), total: Double(s.dailyLimit)).tint(.white) }
      Spacer(minLength: 0)
      if let s = e.s {
        if s.pending > 0 { Text(zh ? "\(s.pending) 件待批准" : "\(s.pending) waiting for you").font(.caption2.weight(.bold)).foregroundStyle(.yellow) }
        else if let a = s.lastAgent, let amt = s.lastAmount { Text("\(a) · \(SharedSpend.fmt(amt, zh))").font(.caption2).foregroundStyle(.white.opacity(0.85)).lineLimit(1) }
        if family != .systemSmall { Text((zh ? "余额 " : "Balance ") + "••••").font(.caption2).foregroundStyle(.white.opacity(0.75)) }
      } else { Text(zh ? "打开 Kipurse 登录" : "Open Kipurse to sign in").font(.caption2).foregroundStyle(.white.opacity(0.85)) }
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
     .widgetBackground(LinearGradient(colors: [Color(red: 0.36, green: 0.30, blue: 0.94), Color(red: 0.49, green: 0.23, blue: 0.93)], startPoint: .topLeading, endPoint: .bottomTrailing))
  }
}
extension View {
  @ViewBuilder func widgetBackground(_ g: LinearGradient) -> some View {
    if #available(iOS 17.0, *) { containerBackground(g, for: .widget) } else { padding().background(g) }
  }
}
struct SpendWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "KipurseSpend", provider: SpendProvider()) { SpendWidgetView(e: $0) }
      .configurationDisplayName("Kipurse").description("What your AI spent today.").supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
  }
}
#if canImport(ActivityKit)
@available(iOS 16.2, *)
struct SpendLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SpendActivityAttributes.self) { ctx in
      let st = ctx.state
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text(st.chinese ? "AI 今天花了" : "AI spent today").font(.caption).foregroundStyle(.secondary)
          Text(SharedSpend.fmt(st.spentToday, st.chinese)).font(.title2.bold()).monospacedDigit()
          if st.dailyLimit > 0 { ProgressView(value: Double(min(st.spentToday, st.dailyLimit)), total: Double(st.dailyLimit)) }
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 4) {
          Text(st.lastAgent).font(.caption.weight(.semibold))
          Text("−" + SharedSpend.fmt(st.lastAmount, st.chinese)).font(.callout.monospacedDigit())
          if st.pending > 0 { Text(st.chinese ? "\(st.pending) 件待批准" : "\(st.pending) to approve").font(.caption2.bold()).foregroundStyle(.orange) }
        }
      }.padding()
    } dynamicIsland: { ctx in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Text(SharedSpend.fmt(ctx.state.spentToday, ctx.state.chinese)).font(.title3.bold()) }
        DynamicIslandExpandedRegion(.trailing) { Text(ctx.state.lastAgent).font(.caption) }
        DynamicIslandExpandedRegion(.bottom) { if ctx.state.dailyLimit > 0 { ProgressView(value: Double(min(ctx.state.spentToday, ctx.state.dailyLimit)), total: Double(ctx.state.dailyLimit)) } }
      } compactLeading: { Image(systemName: "sparkles") } compactTrailing: { Text(SharedSpend.fmt(ctx.state.spentToday, ctx.state.chinese)).font(.caption2.monospacedDigit()) } minimal: { Image(systemName: "sparkles") }
    }
  }
}
#endif
@main
struct KipurseWidgets: WidgetBundle {
  var body: some Widget {
    SpendWidget()
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) { SpendLiveActivity() }
    #endif
  }
}
