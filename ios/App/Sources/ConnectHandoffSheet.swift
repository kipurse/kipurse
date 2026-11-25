import SwiftUI
import KipurseCore

/// t1254 (decision 123): shown after "[zh]" on the first-connect limits page, before jumping to an outside AI.
/// Display + the same launch as before; nothing here saves, grants or signs.
struct ConnectHandoffItem: Identifiable { let id = UUID(); let target: AIConnect }

struct ConnectHandoffSheet: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  let item: ConnectHandoffItem
  var name: String { item.target.displayName }
  var kind: ConnectHandoff.Kind {
    switch item.target {
    case .muse, .siri: return .muse
    case .card(let id): return AgentCard.mainnet.first { $0.id == id }?.prefill == true ? .prefill : .paste
    }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: KP.Space.cardGap) {
          Text(ConnectHandoff.title(name)).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("handoff.title")
          if let g = AIConnect.pendingAmounts {
            WarnBox(text: ConnectHandoff.staged(single: g.single, daily: g.daily, term: g.term), icon: "clock.badge.exclamationmark")
              .accessibilityIdentifier("handoff.staged")
          }
          VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(ConnectHandoff.steps(name, kind: kind).enumerated()), id: \.offset) { i, t in step(i + 1, t, last: i == ConnectHandoff.steps(name, kind: kind).count - 1) }
          }.card(padding: 18).accessibilityElement(children: .combine).accessibilityIdentifier("handoff.steps")
          Label(ConnectHandoff.nothingYet, systemImage: "lock.shield").font(.footnote).foregroundStyle(.secondary)
          BigButton(ConnectHandoff.button(name, kind: kind), icon: "arrow.up.forward.app") {
            let t = item.target
            dismiss()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { AIConnect.resumeArmed = true; t.launch(m) }
          }.accessibilityIdentifier("handoff.go")
          BigButton(ConnectHandoff.later, kind: .secondary) { dismiss() }.accessibilityIdentifier("handoff.later")
        }.padding(20)
      }
      .background(MockBG()).navigationBarTitleDisplayMode(.inline)
    }
  }
  private func step(_ n: Int, _ t: String, last: Bool) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: last ? "faceid" : "\(n).circle.fill").font(.title3).foregroundStyle(last ? Brand.positive : Brand.accent).frame(width: 28)
      Text(t).font(last ? .body.weight(.semibold) : .body).fixedSize(horizontal: false, vertical: true)
    }
  }
}
