/**
 * 试卷工坊 · Android App
 *
 * M1 外壳：WebView 装服务器上的网页（改网页 = 改 App ✓ 不消耗 OTA 额度 ✓）
 * M2 分享目标：微信里长按 PDF → 分享 → 选「试卷工坊」→ 弹窗选预设 → 直接提交 ✓
 * M3 通知：提交后前台服务盯状态 → 完成/失败弹本地通知 ✓（不依赖 FCM ✗ 国内可用 ✓）
 *
 * 地址与口令内置 → 打开即用，无任何配置 ✓
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, Modal, SafeAreaView, ScrollView,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import { useSharedPdf, type SharedPdf } from './src/share';
import { ensureReady, watchTask } from './src/notify';

// ── 内置配置（换人只改这两行：token 换成对方的即可）──
const SERVER = 'https://macbook-air-2.tailad752a.ts.net';
const TOKEN = 'oyi4oDHszkPD3DxvDVyhj9O5N74kNfkS';
const START_URL = `${SERVER}/#token=${TOKEN}`;

export default function App() {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [presets, setPresets] = useState<string[]>([]);
  const [shared, setShared] = useState<SharedPdf | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // 通知权限 + 频道（一次性）
  useEffect(() => { void ensureReady(); }, []);

  // 预设列表（按钮直接用，不在 App 里写死 ✗ 改了服务器即可生效 ✓）
  useEffect(() => {
    fetch(`${SERVER}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } })
      .then(res => res.json())
      .then((body: { presets?: string[] }) => { if (Array.isArray(body?.presets)) { setPresets(body.presets); } })
      .catch(() => { /* 离线时用空列表，用户仍可在网页里操作 ✓ */ });
  }, []);

  // 安卓返回键：网页能后退就后退，否则交给系统
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (shared !== null) { setShared(null); return true; }
      webRef.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, [shared]);

  // M2：收到微信分享过来的文件
  const onShared = useCallback((file: SharedPdf) => {
    setNote('已收到分享的文件：' + file.name);
    setShared(file);
  }, []);
  useSharedPdf(onShared);

  // 把分享的文件提交给电脑端
  const submitShared = useCallback(async (preset: string) => {
    if (shared === null) { return; }
    setBusy(true);
    setNote('正在上传并提交…');
    try {
      const res = await fetch(`${SERVER}/api/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ instruction: preset, files: [{ name: shared.name, contentBase64: shared.base64 }] }),
      });
      const body = (await res.json()) as { taskId?: string; error?: string };
      if (res.status !== 202 || body.taskId === undefined) {
        setNote('提交失败：' + JSON.stringify(body));
        setBusy(false);
        return;
      }
      setNote('已提交（' + preset + '），完成后会通知你 ✓ 也可以直接看下面的网页进度。');
      // M3：盯状态 + 通知
      watchTask({ taskId: body.taskId, server: SERVER, token: TOKEN, onDone: status => setNote('任务结束：' + status) });
      setShared(null);
      webRef.current?.reload();
    } catch (error) {
      setNote('提交出错：' + String(error));
    }
    setBusy(false);
  }, [shared]);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {failed !== null ? (
        <View style={styles.center}>
          <Text style={styles.errTitle}>连不上电脑端</Text>
          <Text style={styles.errBody}>{failed}</Text>
          <Text style={styles.hint}>
            请确认：① 家里的电脑开着、接着电源、没合盖{'\n'}② 手机能上网（本 App 通过 Tailscale Funnel 访问你家电脑）
          </Text>
          <TouchableOpacity style={styles.btn} onPress={() => { setFailed(null); setLoading(true); webRef.current?.reload(); }}>
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
          startInLoadingState
          onLoadEnd={() => setLoading(false)}
          onError={event => { setLoading(false); setFailed(event.nativeEvent.description ?? '网络错误'); }}
          onHttpError={event => { if (event.nativeEvent.statusCode >= 500) { setFailed(`服务器返回 ${event.nativeEvent.statusCode}`); } }}
        />
      )}

      {loading && failed === null ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.loadingText}>正在连接电脑端…</Text>
        </View>
      ) : null}

      {note !== '' ? (
        <View style={styles.note}><Text style={styles.noteText}>{note}</Text></View>
      ) : null}

      {/* M2：分享进来的文件 → 选预设 → 提交 */}
      <Modal visible={shared !== null} transparent animationType="slide" onRequestClose={() => setShared(null)}>
        <View style={styles.modalBg}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>收到文件</Text>
            <Text style={styles.sheetFile} numberOfLines={2}>{shared?.name ?? ''}</Text>
            <Text style={styles.sheetHint}>选一个操作，处理完会发通知给你：</Text>
            <ScrollView style={{ maxHeight: 300 }}>
              {presets.length === 0 ? (
                <Text style={styles.sheetHint}>（没取到预设列表，请到网页里操作）</Text>
              ) : presets.map(name => (
                <TouchableOpacity key={name} style={styles.preset} disabled={busy} onPress={() => void submitShared(name)}>
                  <Text style={styles.presetText}>{name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.cancel} onPress={() => setShared(null)}>
              <Text style={styles.cancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  note: { position: 'absolute', left: 12, right: 12, bottom: 16, backgroundColor: 'rgba(15,23,42,.92)', borderRadius: 12, padding: 12 },
  noteText: { color: '#f8fafc', fontSize: 13, lineHeight: 19 },
  modalBg: { flex: 1, backgroundColor: 'rgba(15,23,42,.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, paddingBottom: 26 },
  sheetTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  sheetFile: { fontSize: 14, color: '#2563eb', marginTop: 6, fontWeight: '600' },
  sheetHint: { fontSize: 13, color: '#64748b', marginTop: 12, marginBottom: 8 },
  preset: { borderWidth: 1.5, borderColor: '#bfdbfe', backgroundColor: '#f8fbff', borderRadius: 12, padding: 16, marginBottom: 10 },
  presetText: { color: '#1d4ed8', fontWeight: '700', fontSize: 16 },
  cancel: { marginTop: 6, padding: 14, alignItems: 'center' },
  cancelText: { color: '#64748b', fontSize: 15 },
});
