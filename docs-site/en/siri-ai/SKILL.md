# kipurse-pay (Siri AI skill draft, Plan B prep; not shipped)

Status: preparation only. The iOS 27.2 SDK used for TestFlight has no `@AppIntent(.tool)` / ToolIntent, so nothing here is compiled.
Siri AI developer preview (iOS 27.3 beta) does not list Simplified Chinese yet.

## What the tool may do
- Pay a **saved** payee (already paid before, or the owner's own Coinbase wallet). Never pay a literal address the user dictates.
- Amount in USDC, at least 0.01.
- Inside the owner's voice allowance (per payment / per day) a known payee is paid without opening the app.
- Over the allowance, a new payee, or resuming after a pause: hand off to Kipurse and require Face ID.
- If "Pause AI payments" is on, every AI including this one is refused; tell the user to resume in Settings → Security.

## Never
- Read or speak the full address, balance, keys or recovery data.
- Retry a refused payment with a different amount to slip under a cap.

## Planned code changes when the SDK supports it
1. Add `.tool` to PayIntent / PayPresetIntent / RepeatPaymentIntent with plain descriptions (no assistant brand names: ITMS-90626).
2. Balance property requires authentication; address property stays internal.
3. Start a Live Activity after a payment so follow-ups work without naming the app.
4. Siri Evaluations scenarios in zh/en; internal TestFlight only until Apple opens App Store submission.
