# Kipurse fees (transparent, all in USDC)
Every fee is taken in USDC from your Kipurse wallet balance. Nothing is charged to a card, and nobody else covers it.

| Item | How much | When |
|---|---|---|
| Kipurse service fee | `feePpm` from the on-chain fee controller (shown as %), rounded up to 0.000001 USDC | each AI payment |
| On-chain network cost | actual gas cost converted to USDC, 0% markup (`PRINCIPLES.gasMarginBps = 0`) | each on-chain transaction |
| Withdrawal / pause | only actual network cost | when you do it |

Before every approval the gateway builds a receipt (`server/src/v5/receipt.mjs`): amount to merchant, service fee, network cost, total deducted from wallet balance; the iOS app shows the fee on the approval screen before Face ID (`ios/Sources/KipurseCore/RequestVerify.swift`).
Fee changes require an owner decision and a new on-chain fee-controller value; they are visible on-chain.
