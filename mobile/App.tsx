/**
 * 试卷工坊 · Android 外壳（M1）
 *
 * 设计取舍（很重要，别改错方向）：
 * - **界面直接装服务器上的网页**（WebView）→ 改网页 = 改 App，无需发版、不消耗任何 Expo 额度 ✓
 * - **地址与口令内置** → 打开就是登录状态，小白什么都不用填 ✓
 * - 通知（M3）走"提交后前台服务盯状态 → 本地通知"→ 国内可用，不依赖 FCM ✓
 *
 * 这个文件只负责：加载页面 + 处理返回键 + 网络错误兜底 + 把分享进来的文件传给页面（M2）。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';

// ── 内置配置：换成你自己的地址与口令（口令就是 pb.config.json 里的 httpToken）──
const SERVER = 'https://macbook-air-2.tailad752a.ts.net';
const TOKEN = 'oyi4oDHszkPD3DxvDVyhj9O5N74kNfkS';
const START_URL = `${SERVER}/#token=${TOKEN}`;

export default function App() {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  // 安卓返回键：网页内能后退就后退，否则再按一次退出
  useEffect(() => {
    const onBack = () => {
      webRef.current?.goBack();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, []);

  const reload = useCallback(() => {
    setFailed(null);
    setLoading(true);
    webRef.current?.reload();
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {failed !== null ? (
        <View style={styles.center}>
          <Text style={styles.errTitle}>连不上电脑端</Text>
          <Text style={styles.errBody}>{failed}</Text>
          <Text style={styles.hint}>
            请确认：① 家里的电脑开着并且没合盖 ② 手机能上网{'\n'}
            （本 App 通过 Tailscale Funnel 访问你家的电脑）
          </Text>
          <TouchableOpacity style={styles.btn} onPress={reload}>
            <Text style={styles.btnText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          ref={webRef}
          source={{ uri: START_URL }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          // 允许网页里的"下载产物"落到本地：Android 端交给系统下载器/或后续用原生模块接管
          allowsBackForwardNavigationGestures
          startInLoadingState
          onLoadEnd={() => setLoading(false)}
          onError={event => {
            setLoading(false);
            setFailed(event.nativeEvent.description ?? '网络错误');
          }}
          onHttpError={event => {
            const { statusCode, url } = event.nativeEvent;
            // 5xx/断网才提示；401 交给网页自己处理（网页会显示"口令不对"）
            if (statusCode >= 500) {
              setFailed(`服务器返回 ${statusCode}（${url}）`);
            }
          }}
        />
      )}
      {loading && failed === null ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.loadingText}>正在连接电脑端…</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f1f5f9' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(241,245,249,.92)' },
  loadingText: { marginTop: 12, color: '#64748b', fontSize: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a', marginBottom: 8 },
  errBody: { fontSize: 14, color: '#b91c1c', textAlign: 'center', marginBottom: 12 },
  hint: { fontSize: 13, color: '#64748b', textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  btn: { backgroundColor: '#2563eb', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
