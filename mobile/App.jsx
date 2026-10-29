import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const REQUIRED_SAMPLES = 30;

async function requestApi(baseUrl, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the API. Check the URL and internet connection. ${error.message}`,
    );
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`The API returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(result.detail || `The API request failed (HTTP ${response.status}).`);
  }
  return result;
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [apiUrl, setApiUrl] = useState('https://frs-opencv.onrender.com');
  const [name, setName] = useState('');
  const [profile, setProfile] = useState(null);
  const [events, setEvents] = useState([]);
  const [mode, setMode] = useState('idle');
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Connect to the API to get started.');
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const cameraRef = useRef(null);
  const modeRef = useRef({ type: 'idle', sessionId: null });
  const busyRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    const result = await requestApi(apiUrl, '/api/status');
    setProfile(result.registered ? result.name : null);
    setEvents(result.events || []);
    return result;
  }, [apiUrl]);

  const stopFlow = useCallback(() => {
    const current = modeRef.current;
    modeRef.current = { type: 'idle', sessionId: null };
    setMode('idle');
    if (current.type === 'register') {
      requestApi(apiUrl, '/api/register/cancel', {}).catch((error) => {
        setStatus(`Stopped on this device. Could not cancel on the server: ${error.message}`);
      });
    } else if (current.type === 'attendance' && current.sessionId) {
      requestApi(apiUrl, '/api/attendance/cancel', {
        session_id: current.sessionId,
      }).catch((error) => {
        setStatus(`Stopped on this device. Could not cancel on the server: ${error.message}`);
      });
    }
  }, [apiUrl]);

  useEffect(() => {
    if (mode === 'idle' || !cameraReady) return undefined;
    const timer = setInterval(async () => {
      if (busyRef.current || !cameraRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const photo = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: 0.35,
          skipProcessing: true,
        });
        if (!photo?.base64) throw new Error('The camera did not return an image.');

        const current = modeRef.current;
        if (current.type === 'register') {
          const result = await requestApi(apiUrl, '/api/register/frame', {
            image: photo.base64,
          });
          if (result.status === 'registered') {
            modeRef.current = { type: 'idle', sessionId: null };
            setMode('idle');
            setProgress(REQUIRED_SAMPLES);
            setProfile(result.name);
            setStatus(`Registration complete for ${result.name}.`);
            await refreshStatus();
          } else {
            setProgress(result.collected || 0);
            setStatus(
              result.status === 'face_not_found'
                ? 'Face not found. Center your face in the camera.'
                : result.status === 'multiple_faces'
                  ? 'Only one person should be visible.'
                  : `Capturing face samples: ${result.collected}/${result.required}. Move your head slightly.`,
            );
          }
        } else if (current.type === 'attendance') {
          const result = await requestApi(apiUrl, '/api/attendance/frame', {
            session_id: current.sessionId,
            image: photo.base64,
          });
          setStatus(result.message || 'Checking face...');
          if (result.status === 'recorded') {
            modeRef.current = { type: 'idle', sessionId: null };
            setMode('idle');
            await refreshStatus();
          }
        }
      } catch (error) {
        modeRef.current = { type: 'idle', sessionId: null };
        setMode('idle');
        setStatus(error.message);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }, 850);
    return () => clearInterval(timer);
  }, [apiUrl, cameraReady, mode, refreshStatus]);

  const connect = async () => {
    Keyboard.dismiss();
    if (!apiUrl.trim()) {
      setStatus('Enter the deployed API URL first.');
      return;
    }
    setLoading(true);
    try {
      const result = await refreshStatus();
      setStatus(
        result.registered
          ? `Connected. Registered face: ${result.name}.`
          : 'Connected. Register a face to get started.',
      );
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  };

  const startRegistration = async () => {
    Keyboard.dismiss();
    if (!apiUrl.trim()) {
      setStatus('Enter the deployed API URL first.');
      return;
    }
    if (!name.trim()) {
      Alert.alert('Name required', 'Enter the name to register.');
      return;
    }
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setStatus('Camera permission is needed to register a face.');
        return;
      }
    }
    setLoading(true);
    try {
      await requestApi(apiUrl, '/api/register/start', { name: name.trim() });
      modeRef.current = { type: 'register', sessionId: null };
      setProgress(0);
      setMode('register');
      setStatus('Registration started. Look at the camera and move your head slightly.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  };

  const startAttendance = async (action) => {
    Keyboard.dismiss();
    if (!apiUrl.trim()) {
      setStatus('Enter the deployed API URL first.');
      return;
    }
    if (!profile) {
      setStatus('Register a face before recording attendance.');
      return;
    }
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setStatus('Camera permission is needed to record attendance.');
        return;
      }
    }
    setLoading(true);
    try {
      const result = await requestApi(apiUrl, '/api/attendance/start', { action });
      modeRef.current = { type: 'attendance', sessionId: result.session_id };
      setMode('attendance');
      setStatus(`Ready for ${action}. Look at the camera, then blink.`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  };

  const onCancel = () => {
    stopFlow();
    setStatus('Cancelled.');
  };

  const cameraActive = mode !== 'idle';

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.eyebrow}>OPENCV · EXPO</Text>
        <Text style={styles.title}>Face attendance</Text>
        <Text style={styles.subtitle}>Register one face, then blink to clock in or out.</Text>

        <View style={styles.card}>
          <Text style={styles.label}>PYTHON API</Text>
          <View style={styles.urlRow}>
            <TextInput
              value={apiUrl}
              onChangeText={setApiUrl}
              placeholder="https://your-service.onrender.com"
              placeholderTextColor="#728094"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
              editable={!cameraActive}
            />
            <Pressable style={styles.smallButton} onPress={connect} disabled={loading}>
              <Text style={styles.smallButtonText}>Connect</Text>
            </Pressable>
          </View>
          <Text style={styles.helpText}>
            Paste the HTTPS URL shown by Render after deployment.
          </Text>
        </View>

        <View style={styles.cameraCard}>
          {!permission?.granted ? (
            <View style={styles.cameraMessage}>
              <Text style={styles.cameraMessageText}>Camera permission is required.</Text>
              <Pressable style={styles.primaryButton} onPress={requestPermission}>
                <Text style={styles.primaryButtonText}>Allow camera</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <CameraView
                ref={cameraRef}
                style={styles.camera}
                facing="front"
                onCameraReady={() => setCameraReady(true)}
                onMountError={(event) => setStatus(event.message || 'Could not start camera.')}
              />
              <View style={styles.cameraBadge}>
                <View style={[styles.dot, cameraActive && styles.dotActive]} />
                <Text style={styles.cameraBadgeText}>
                  {cameraActive ? (busy ? 'Checking…' : 'Camera active') : 'Camera ready'}
                </Text>
              </View>
              {cameraActive && (
                <Pressable style={styles.cancelButton} onPress={onCancel}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
              )}
            </>
          )}
        </View>

        <View style={styles.statusCard}>
          <Text style={styles.label}>STATUS</Text>
          <Text style={styles.statusText}>{status}</Text>
          {mode === 'register' && (
            <View style={styles.progressTrack}>
              <View
                style={[styles.progressFill, { width: `${(progress / REQUIRED_SAMPLES) * 100}%` }]}
              />
            </View>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Registration</Text>
          <Text style={styles.helpText}>
            {profile ? `Currently registered: ${profile}` : 'No face registered yet.'}
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Enter person’s name"
            placeholderTextColor="#728094"
            style={styles.input}
            editable={!cameraActive}
          />
          <Pressable
            style={[styles.primaryButton, (loading || cameraActive) && styles.disabledButton]}
            onPress={startRegistration}
            disabled={loading || cameraActive}
          >
            {loading ? (
              <ActivityIndicator color="#08101d" />
            ) : (
              <Text style={styles.primaryButtonText}>
                {profile ? 'Replace registered face' : 'Register face'}
              </Text>
            )}
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Attendance</Text>
          <View style={styles.actionRow}>
            <Pressable
              style={[styles.actionButton, styles.clockInButton, (!profile || cameraActive || loading) && styles.disabledButton]}
              onPress={() => startAttendance('clock-in')}
              disabled={!profile || cameraActive || loading}
            >
              <Text style={styles.actionButtonText}>Clock in</Text>
            </Pressable>
            <Pressable
              style={[styles.actionButton, styles.clockOutButton, (!profile || cameraActive || loading) && styles.disabledButton]}
              onPress={() => startAttendance('clock-out')}
              disabled={!profile || cameraActive || loading}
            >
              <Text style={styles.actionButtonText}>Clock out</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Recent attendance</Text>
          {events.length === 0 ? (
            <Text style={styles.helpText}>No attendance events recorded.</Text>
          ) : (
            events.map((event, index) => (
              <View style={styles.eventRow} key={`${event.timestamp}-${index}`}>
                <View>
                  <Text style={styles.eventName}>{event.name}</Text>
                  <Text style={styles.eventTime}>
                    {new Date(event.timestamp).toLocaleString()}
                  </Text>
                </View>
                <Text style={styles.eventAction}>{event.action}</Text>
              </View>
            ))
          )}
        </View>
        <Text style={styles.footer}>Demo only · Camera images and face data go to your configured API server.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  content: { paddingHorizontal: 20, paddingTop: 58, paddingBottom: 36, gap: 14 },
  eyebrow: { color: '#62e6b5', fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  title: { color: '#f5f7fb', fontSize: 32, fontWeight: '800', marginTop: -8 },
  subtitle: { color: '#9aa8bb', fontSize: 15, lineHeight: 22, marginTop: -8 },
  card: { backgroundColor: '#141e2e', borderColor: '#243247', borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  label: { color: '#8292a8', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  urlRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, minHeight: 46, color: '#f5f7fb', borderRadius: 10, borderWidth: 1, borderColor: '#34445b', paddingHorizontal: 12, fontSize: 14 },
  smallButton: { backgroundColor: '#26354a', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 14 },
  smallButtonText: { color: '#eaf1f8', fontSize: 13, fontWeight: '700' },
  helpText: { color: '#95a4b8', fontSize: 13, lineHeight: 19 },
  cameraCard: { height: 300, backgroundColor: '#121b29', borderColor: '#243247', borderWidth: 1, borderRadius: 16, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' },
  camera: { width: '100%', height: '100%' },
  cameraMessage: { alignItems: 'center', gap: 14, padding: 20 },
  cameraMessageText: { color: '#b7c2d1', fontSize: 14 },
  cameraBadge: { position: 'absolute', top: 12, left: 12, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#08101dcc', borderRadius: 20, paddingHorizontal: 11, paddingVertical: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#8592a4' },
  dotActive: { backgroundColor: '#62e6b5' },
  cameraBadgeText: { color: '#f2f6fa', fontSize: 12, fontWeight: '700' },
  cancelButton: { position: 'absolute', bottom: 12, right: 12, backgroundColor: '#cf4d58', borderRadius: 10, paddingHorizontal: 15, paddingVertical: 10 },
  cancelButtonText: { color: '#fff', fontWeight: '700' },
  statusCard: { backgroundColor: '#122b2b', borderColor: '#23574e', borderWidth: 1, borderRadius: 14, padding: 15, gap: 8 },
  statusText: { color: '#dce9e7', fontSize: 14, lineHeight: 20 },
  progressTrack: { height: 6, backgroundColor: '#263e40', borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#62e6b5', borderRadius: 3 },
  sectionTitle: { color: '#f3f6fa', fontSize: 17, fontWeight: '750' },
  primaryButton: { minHeight: 48, borderRadius: 11, backgroundColor: '#62e6b5', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  primaryButtonText: { color: '#08101d', fontSize: 14, fontWeight: '800' },
  disabledButton: { opacity: 0.45 },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionButton: { flex: 1, minHeight: 50, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  clockInButton: { backgroundColor: '#4bd6a4' },
  clockOutButton: { backgroundColor: '#769bff' },
  actionButtonText: { color: '#08101d', fontSize: 14, fontWeight: '800' },
  eventRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#26354a', paddingTop: 12 },
  eventName: { color: '#e9eef5', fontSize: 14, fontWeight: '700' },
  eventTime: { color: '#8594a8', fontSize: 12, marginTop: 4 },
  eventAction: { color: '#62e6b5', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  footer: { color: '#65748a', textAlign: 'center', fontSize: 11, marginTop: 2 },
});
