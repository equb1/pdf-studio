# 试卷工坊 · Android App（M1）

手机端外壳：**界面装服务器上的网页**，地址与口令**内置**，打开即用。

> 为什么用 WebView 而不是重写原生界面：改网页 = 改 App ✓ 无需发版 ✓ 不消耗 Expo 的 OTA 额度 ✓
> Expo 免费版额度（实测 [官网](https://expo.dev/pricing)）：**OTA 更新不限次数** ✓ 1,000 MAU ✓ 100 GiB 带宽/月 ✓ 30 次云构建/月 ✓ 免费版不会产生超额扣费 ✓ —— 我们 2 个人用完全够。

## 一、生成工程骨架（一次，需要联网）

```bash
cd /Users/Zhuanz/Desktop/deaktop-tool/pdf-studio
npx create-expo-app@latest mobile --template blank-typescript   # 若 mobile/ 已存在会提示，选“继续”即可
cd mobile
npx expo install react-native-webview expo-status-bar
npm i -D expo-build-properties
```

然后把本目录里我已经写好的 `App.tsx` 与 `app.json` **覆盖**过去（它们就是上面这套配置 ✓）。

## 二、放图标（用你项目里已有的图）

`app.json` 里引用了三个文件，把现有图片拷成这些名字即可：

```bash
cd mobile
mkdir -p assets
cp <你项目里的图标>.png assets/icon.png            # 1024×1024
cp <你项目里的图标>.png assets/adaptive-icon.png   # 1024×1024（安卓自适应图标前景）
cp <你项目里的启动图>.png assets/splash.png         # 可选，没有就用 icon 代替
```

## 三、把地址与口令换成你自己的

`App.tsx` 顶部两行：

```ts
const SERVER = 'https://macbook-air-2.tailad752a.ts.net';   // 你的 Funnel 地址
const TOKEN  = '……';                                        // pb.config.json 里的 httpToken
```

> 想给两个人各发一个版本？把 `TOKEN` 换成对方那个 token 再构建一次即可 ✓
> （或者做成"启动时读 `#token=`"，以后再用 OTA 下发 ✓）

## 四、构建 APK（两条路任选）

**路线 A：EAS 云构建（推荐，本机不用装 SDK）**

```bash
cd mobile
npx eas-cli login                 # 用你的 Expo 账号
npx eas-cli init                  # 生成 projectId → 填进 app.json 的 extra.eas.projectId
npx eas-cli build -p android --profile preview
```

首次会问要不要生成 keystore ✓ 选**是**（EAS 帮你保管 ✓）。构建完成后页面会给一个 **APK 下载链接** ✓ 手机装上即可 ✓。

**路线 B：本机 Android Studio 构建**

```bash
cd mobile
npx expo prebuild -p android      # 生成 android/ 原生工程
npx expo run:android --variant release
# 产物：android/app/build/outputs/apk/release/app-release.apk
```

## 五、装到手机上

1. 把 APK 传到手机（微信发给自己 → 用"其他应用打开"，或数据线 ✓）
2. 安装时允许"未知来源"✓
3. 打开 → 应**直接进入主界面**（不用填口令 ✓）

## 六、验收标准（M1）

- [ ] 打开 App 直接看到"试卷工坊"界面（就是现在那个网页 ✓ 顶部无浏览器地址栏 ✓）
- [ ] 选 PDF → 点预设 → 跑完 → **下载 / 转发到微信** 两个按钮都在 ✓
- [ ] 安卓返回键：网页内可后退；退到底再按一次才退出 ✓
- [ ] 断网时有中文错误页 + 重试按钮 ✓（不是白屏 ✓）

## 后续里程碑

| 阶段 | 内容 | 关键点 |
|---|---|---|
| **M2** | **分享目标**：微信里长按 PDF → 分享 → 选「试卷工坊」 | 需要 `expo-share-intent`（或 `app.json` 里已写好的 `intentFilters` + 一个原生模块）✓ 拿到文件后调网页的上传接口 ✓ |
| **M3** | **完成/失败通知**：提交后起前台服务盯状态 → 弹本地通知 | 用 `notifee` ✓ **不依赖 FCM** ✓（国内 FCM 不通 ✗）。注意：App 被从后台划掉时通知可能不来 ✗（要彻底可靠只能上厂商推送 ✗）|
| **M4** | 自托管 OTA（可选） | `expo-updates` 指向你自己的服务器 ✓ 完全不经过 Expo ✓ |

## 已知限制（如实记录）

1. **Android 优先**，iOS 后面做（RN 一套代码可复用 ✓ 但 iOS 需要 Apple 开发者账号 $99/年 ✗）
2. App 前台的"下载产物"目前走系统下载器 ✓；要做到"下载后**自动**弹分享给微信" ✓ 需要 M2 的原生模块接管下载 ✓（网页版现在是用户点一下分享 ✓ 已经能用 ✓）
3. 通知在"App 被彻底划掉"时不保证送达 ✗
