# kipurse-pay（Siri AI 技能草案，B 计划准备，尚未上线）

状态：仅为准备工作。TestFlight 使用的 iOS 27.2 SDK 没有 `@AppIntent(.tool)` / ToolIntent，所以这里的内容都还没有编译。
Siri AI 开发者预览版（iOS 27.3 beta）目前还不支持简体中文。

## 这个工具可以做什么
- 付款给**已保存**的收款人（以前付过的，或主人自己的 Coinbase 钱包）。绝不付款给用户口述的一串地址。
- 金额以 USDC 计，至少 0.01。
- 在主人设定的语音额度内（每笔 / 每天），付给已知收款人不需要打开 App。
- 超出额度、新收款人、或暂停后恢复：转到启付 App，并要求 Face ID。
- 如果打开了「暂停 AI 付款」，所有 AI（包括这个）都会被拒绝；提示用户到「设置 → 安全」里恢复。

## 绝不
- 读出或念出完整地址、余额、密钥或恢复信息。
- 付款被拒后换一个金额重试，试图绕过额度。

## SDK 支持后计划的代码改动
1. 给 PayIntent / PayPresetIntent / RepeatPaymentIntent 加上 `.tool` 和简单说明（不出现助手品牌名：ITMS-90626）。
2. 余额属性需要身份验证；地址属性只在内部使用。
3. 付款后启动实时活动，这样后续操作不用说出 App 名字。
4. 中英文 Siri 评估场景；在 Apple 开放 App Store 提交前只做内部 TestFlight。
