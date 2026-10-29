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

const REQUIRED_SAMPLES = 8;
const DEFAULT_API_URL = 'https://frs-opencv.onrender.com';

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

  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    if (!response.ok) {
      const bodyText = responseText.trim().slice(0, 240) || 'Empty response body.';
      throw new Error(`The API returned HTTP ${response.status}: ${bodyText}`);
    }
    throw new Error(`The API returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(result.detail || `The API request failed (HTTP ${response.status}).`);
  }
  return result;
}

function formatTime(value) {
  if (!value) return '--:--';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '--:--'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.floor(totalMinutes || 0));
  return {
    hours: String(Math.floor(minutes / 60)).padStart(2, '0'),
    minutes: String(minutes % 60).padStart(2, '0'),
  };
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState(null);
  const [events, setEvents] = useState([]);
  const [attendance, setAttendance] = useState({
    clocked_in: false,
    clock_in_time: null,
    clock_out_time: null,
    duration_minutes: 0,
  });
  const [mode, setMode] = useState('idle');
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Connect to load your attendance status.');
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showRegistration, setShowRegistration] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [now, setNow] = useState(Date.now());
  const cameraRef = useRef(null);
  const modeRef = useRef({ type: 'idle', sessionId: null });
  const busyRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    const result = await requestApi(apiUrl, '/api/status');
    setProfile(result.registered ? result.name : null);
    setEvents(result.events || []);
    setAttendance({
      clocked_in: result.clocked_in || false,
      clock_in_time: result.clock_in_time || null,
      clock_out_time: result.clock_out_time || null,
      duration_minutes: result.duration_minutes || 0,
    });
    return result;
  }, [apiUrl]);

  useEffect(() => {
    refreshStatus().then(
      (result) => {
        setStatus(
          result.registered
            ? `Welcome back, ${result.name}.`
            : 'Register your face to get started.',
        );
      },
      (error) => setStatus(error.message),
    );
  }, [refreshStatus]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const stopFlow = useCallback(() => {
    const current = modeRef.current;
    modeRef.current = { type: 'idle', sessionId: null };
    setMode('idle');
    setCameraReady(false);
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
    const interval = mode === 'register' ? 220 : 240;
    const timer = setInterval(async () => {
      if (busyRef.current || !cameraRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const photo = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: 0.3,
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
            setCameraReady(false);
            setProgress(REQUIRED_SAMPLES);
            setProfile(result.name);
            setShowRegistration(false);
            setStatus(`Face registration complete for ${result.name}.`);
            await refreshStatus();
          } else {
            setProgress(result.collected || 0);
            setStatus(
              result.status === 'face_not_found'
                ? 'Face not found. Center your face in the camera.'
                : result.status === 'multiple_faces'
                  ? 'Only one person should be visible.'
                  : `Capturing face samples: ${result.collected}/${result.required}. Look at the camera and move slightly.`,
            );
          }
        } else if (current.type === 'attendance') {
          const result = await requestApi(apiUrl, '/api/attendance/frame', {
            session_id: current.sessionId,
            image: photo.base64,
          });
          setStatus(result.message || 'Checking your face…');
          if (result.status === 'recorded') {
            modeRef.current = { type: 'idle', sessionId: null };
            setMode('idle');
            setCameraReady(false);
            await refreshStatus();
          }
        }
      } catch (error) {
        modeRef.current = { type: 'idle', sessionId: null };
        setMode('idle');
        setCameraReady(false);
        setStatus(error.message);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }, interval);
    return () => clearInterval(timer);
  }, [apiUrl, cameraReady, mode, refreshStatus]);

  const connect = async () => {
    Keyboard.dismiss();
    if (!apiUrl.trim()) {
      setStatus('Enter the API URL first.');
      return;
    }
    setLoading(true);
    try {
      const result = await refreshStatus();
      setStatus(
        result.registered
          ? `Connected. Welcome, ${result.name}.`
          : 'Connected. Register your face to get started.',
      );
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  };

  const ensureCameraPermission = async () => {
    if (permission?.granted) return true;
    const result = await requestPermission();
    if (!result.granted) {
      setStatus('Camera permission is needed to continue.');
      return false;
    }
    return true;
  };

  const startRegistration = async () => {
    Keyboard.dismiss();
    const registrationName = name.trim() || profile || '';
    if (!registrationName) {
      Alert.alert('Name required', 'Enter the name to register.');
      return;
    }
    if (!(await ensureCameraPermission())) return;
    setLoading(true);
    try {
      await requestApi(apiUrl, '/api/register/start', { name: registrationName });
      modeRef.current = { type: 'register', sessionId: null };
      setCameraReady(false);
      setProgress(0);
      setMode('register');
      setStatus(`Look at the camera while we capture ${REQUIRED_SAMPLES} samples.`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  };

  const startAttendance = async (action) => {
    Keyboard.dismiss();
    if (!profile) {
      setStatus('Register a face before recording attendance.');
      return;
    }
    if (action === 'clock-in' && attendance.clocked_in) {
      setStatus(`Already clocked in at ${formatTime(attendance.clock_in_time)}.`);
      return;
    }
    if (action === 'clock-out' && !attendance.clocked_in) {
      setStatus('Clock in before trying to clock out.');
      return;
    }
    if (!(await ensureCameraPermission())) return;
    setLoading(true);
    try {
      const result = await requestApi(apiUrl, '/api/attendance/start', { action });
      modeRef.current = { type: 'attendance', sessionId: result.session_id };
      setCameraReady(false);
      setMode('attendance');
      setStatus(`Ready for ${action}. Look at the camera, then blink to record.`);
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
  const shiftDuration = attendance.clocked_in && attendance.clock_in_time
    ? Math.max(
        0,
        Math.floor(
          (now - new Date(attendance.clock_in_time).getTime()) / 60000,
        ),
      )
    : attendance.duration_minutes;
  const duration = formatDuration(shiftDuration);
  const clockInDisabled = !profile || attendance.clocked_in || cameraActive || loading;
  const clockOutDisabled = !profile || !attendance.clocked_in || cameraActive || loading;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <Text style={styles.brand}>APCFSS</Text>
            <Text style={styles.brandTag}>ATTENDANCE</Text>
          </View>
          <View style={styles.welcomeBlock}>
            <Text style={styles.welcome}>Welcome</Text>
            <Text style={styles.personName}>{profile || 'Face attendance'}</Text>
          </View>
          <View style={styles.headerOrb} />
        </View>

        <View style={styles.attendanceCard}>
          <View style={styles.actionPanel}>
            <Pressable
              style={styles.actionHalf}
              onPress={() => startAttendance('clock-in')}
              disabled={clockInDisabled}
            >
              <Text style={[styles.actionTitle, clockInDisabled && styles.actionDisabled]}>
                Clock In
              </Text>
              <Text style={styles.actionTime}>
                {attendance.clock_in_time ? formatTime(attendance.clock_in_time) : 'Not clocked in'}
              </Text>
              <Text style={styles.actionHint}>
                {attendance.clocked_in ? 'Already recorded' : 'Tap and blink to record'}
              </Text>
            </Pressable>
            <View style={styles.verticalRule} />
            <Pressable
              style={styles.actionHalf}
              onPress={() => startAttendance('clock-out')}
              disabled={clockOutDisabled}
            >
              <Text style={[styles.actionTitle, clockOutDisabled && styles.actionDisabled]}>
                Clock Out
              </Text>
              <Text style={styles.actionTime}>
                {attendance.clock_out_time ? formatTime(attendance.clock_out_time) : 'Not clocked out'}
              </Text>
              <Text style={styles.actionHint}>
                {attendance.clocked_in ? 'Tap and blink to record' : 'Clock in first'}
              </Text>
            </Pressable>
          </View>
          <View style={styles.progressRule} />
          <View style={styles.shiftInfo}>
            <View style={styles.shiftSide}>
              <Text style={styles.shiftLabel}>CLOCK IN</Text>
              <Text style={styles.shiftTime}>{formatTime(attendance.clock_in_time)}</Text>
            </View>
            <View style={styles.shiftSide}>
              <Text style={styles.shiftLabel}>CLOCK OUT</Text>
              <Text style={styles.shiftTime}>{formatTime(attendance.clock_out_time)}</Text>
            </View>
          </View>
          <View style={styles.timerCircle}>
            <Text style={styles.timerValue}>{duration.hours}</Text>
            <Text style={styles.timerUnit}>HOURS</Text>
            <Text style={styles.timerValue}>{duration.minutes}</Text>
            <Text style={styles.timerUnit}>MINUTES</Text>
          </View>
        </View>

        {cameraActive && (
          <View style={styles.cameraCard}>
            {!permission?.granted ? (
              <ActivityIndicator color="#101080" />
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
                  <View style={[styles.dot, busy && styles.dotActive]} />
                  <Text style={styles.cameraBadgeText}>
                    {mode === 'register'
                      ? `Registration ${progress}/${REQUIRED_SAMPLES}`
                      : busy
                        ? 'Checking face…'
                        : 'Look at camera and blink'}
                  </Text>
                </View>
                <Pressable style={styles.cancelButton} onPress={onCancel}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
              </>
            )}
          </View>
        )}

        <View style={styles.statusRow}>
          <View style={[styles.statusDot, attendance.clocked_in && styles.statusDotActive]} />
          <Text style={styles.statusText}>{status}</Text>
        </View>

        <View style={styles.quickActions}>
          <QuickAction
            label="Clock In"
            mark="IN"
            disabled={clockInDisabled}
            onPress={() => startAttendance('clock-in')}
          />
          <QuickAction
            label="Clock Out"
            mark="OUT"
            disabled={clockOutDisabled}
            onPress={() => startAttendance('clock-out')}
          />
          <QuickAction
            label="On Duty"
            mark={attendance.clocked_in ? 'ON' : '—'}
            disabled
            onPress={() => {}}
          />
          <QuickAction
            label="History"
            mark="↻"
            onPress={() => setStatus('Attendance history is shown below.')}
          />
        </View>

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent attendance</Text>
            <Pressable onPress={connect} disabled={loading}>
              <Text style={styles.linkText}>Refresh</Text>
            </Pressable>
          </View>
          {events.length === 0 ? (
            <Text style={styles.helpText}>No attendance events recorded today.</Text>
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

        {!profile && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Register your face</Text>
            <Text style={styles.helpText}>
              Registration now captures {REQUIRED_SAMPLES} samples. Face the camera and move slightly.
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Enter your name"
              placeholderTextColor="#8490a2"
              style={styles.input}
              editable={!cameraActive}
            />
            <Pressable
              style={[styles.registerButton, (loading || cameraActive) && styles.disabledButton]}
              onPress={startRegistration}
              disabled={loading || cameraActive}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.registerButtonText}>Register face</Text>
              )}
            </Pressable>
          </View>
        )}

        {profile && (
          <Pressable
            style={styles.textButton}
            onPress={() => setShowRegistration(!showRegistration)}
          >
            <Text style={styles.linkText}>
              {showRegistration ? 'Hide face registration' : 'Update registered face'}
            </Text>
          </Pressable>
        )}
        {profile && showRegistration && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Update registered face</Text>
            <Text style={styles.helpText}>
              This replaces the existing single-person face profile.
            </Text>
            <Pressable
              style={[styles.registerButton, (loading || cameraActive) && styles.disabledButton]}
              onPress={startRegistration}
              disabled={loading || cameraActive}
            >
              <Text style={styles.registerButtonText}>Capture {REQUIRED_SAMPLES} samples</Text>
            </Pressable>
          </View>
        )}

        <Pressable
          style={styles.settingsToggle}
          onPress={() => setShowSettings(!showSettings)}
        >
          <Text style={styles.linkText}>
            {showSettings ? 'Hide server settings' : 'Server settings'}
          </Text>
        </Pressable>
        {showSettings && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>API URL</Text>
            <View style={styles.urlRow}>
              <TextInput
                value={apiUrl}
                onChangeText={setApiUrl}
                placeholder={DEFAULT_API_URL}
                placeholderTextColor="#8490a2"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.input}
                editable={!cameraActive}
              />
              <Pressable style={styles.smallButton} onPress={connect} disabled={loading}>
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.smallButtonText}>Connect</Text>
                )}
              </Pressable>
            </View>
          </View>
        )}

        <Text style={styles.footer}>Face images are sent to your configured API server.</Text>
      </ScrollView>
    </View>
  );
}

function QuickAction({ label, mark, disabled = false, onPress }) {
  return (
    <Pressable
      style={styles.quickAction}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={[styles.quickIcon, disabled && styles.quickIconDisabled]}>
        <Text style={styles.quickIconText}>{mark}</Text>
      </View>
      <Text style={[styles.quickLabel, disabled && styles.quickLabelDisabled]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8f8fa' },
  content: { paddingBottom: 34 },
  header: {
    height: 330,
    backgroundColor: '#090978',
    paddingTop: 24,
    paddingHorizontal: 22,
    overflow: 'hidden',
  },
  brandRow: { height: 112, justifyContent: 'center' },
  brand: { color: '#fff', fontSize: 41, fontWeight: '900', letterSpacing: 0.5 },
  brandTag: { color: '#12c4ed', fontSize: 17, fontWeight: '700', letterSpacing: 5, marginLeft: 90 },
  welcomeBlock: { marginTop: 28 },
  welcome: { color: '#fff', fontSize: 19 },
  personName: { color: '#fff', fontSize: 25, fontWeight: '700', marginTop: 7 },
  headerOrb: {
    position: 'absolute',
    width: 190,
    height: 190,
    borderRadius: 95,
    right: -88,
    bottom: -34,
    backgroundColor: '#0870c5',
    borderWidth: 3,
    borderColor: '#8ecbff',
    opacity: 0.85,
  },
  attendanceCard: {
    marginTop: -38,
    marginHorizontal: 18,
    backgroundColor: '#eafcff',
    borderRadius: 20,
    minHeight: 310,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 82,
    shadowColor: '#0b1560',
    shadowOpacity: 0.11,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  actionPanel: { flexDirection: 'row', minHeight: 122, alignItems: 'stretch' },
  actionHalf: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  actionTitle: { color: '#151515', fontSize: 21, fontWeight: '500' },
  actionDisabled: { color: '#7d858a' },
  actionTime: { color: '#303a43', fontSize: 14, fontWeight: '700', marginTop: 12 },
  actionHint: { color: '#89939c', fontSize: 11, marginTop: 5, textAlign: 'center' },
  verticalRule: { width: 2, backgroundColor: '#d8e3e7', marginVertical: 8 },
  progressRule: { height: 8, backgroundColor: '#ccd4d6', marginTop: 12, marginBottom: 21 },
  shiftInfo: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  shiftSide: { alignItems: 'center', minWidth: 90 },
  shiftLabel: { color: '#7c8b91', fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  shiftTime: { color: '#171b22', fontSize: 15, fontWeight: '700', marginTop: 5 },
  timerCircle: {
    position: 'absolute',
    width: 132,
    height: 132,
    borderRadius: 66,
    bottom: -56,
    left: '50%',
    marginLeft: -66,
    backgroundColor: '#a00000',
    borderColor: '#fff',
    borderWidth: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerValue: { color: '#fff', fontSize: 26, fontWeight: '700', lineHeight: 29 },
  timerUnit: { color: '#fff', fontSize: 10, marginBottom: 2 },
  cameraCard: {
    height: 280,
    marginHorizontal: 18,
    marginTop: 78,
    backgroundColor: '#18213a',
    borderRadius: 17,
    overflow: 'hidden',
  },
  camera: { width: '100%', height: '100%' },
  cameraBadge: {
    position: 'absolute',
    left: 12,
    top: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#101322dd',
    borderRadius: 20,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#98a0ae' },
  dotActive: { backgroundColor: '#54dfa6' },
  cameraBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  cancelButton: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    backgroundColor: '#a00000',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  cancelButtonText: { color: '#fff', fontWeight: '700' },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 86,
    marginHorizontal: 22,
    minHeight: 30,
    gap: 9,
  },
  statusDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#9299a5' },
  statusDotActive: { backgroundColor: '#168a55' },
  statusText: { color: '#303743', fontSize: 13, flex: 1, lineHeight: 18 },
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    marginHorizontal: 18,
  },
  quickAction: { alignItems: 'center', width: '24%' },
  quickIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#10108b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickIconDisabled: { backgroundColor: '#9da2bd' },
  quickIconText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  quickLabel: { color: '#191b22', fontSize: 13, marginTop: 10 },
  quickLabelDisabled: { color: '#727780' },
  card: {
    backgroundColor: '#fff',
    marginHorizontal: 18,
    marginTop: 24,
    borderRadius: 16,
    padding: 17,
    gap: 12,
    borderColor: '#eceef2',
    borderWidth: 1,
  },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: '#141722', fontSize: 17, fontWeight: '700' },
  linkText: { color: '#10108b', fontSize: 13, fontWeight: '700' },
  helpText: { color: '#687280', fontSize: 13, lineHeight: 19 },
  eventRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#edf0f3',
    paddingTop: 11,
  },
  eventName: { color: '#222735', fontSize: 14, fontWeight: '700' },
  eventTime: { color: '#798391', fontSize: 12, marginTop: 4 },
  eventAction: { color: '#10108b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  input: {
    minHeight: 46,
    color: '#212633',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d7dce4',
    paddingHorizontal: 12,
    fontSize: 14,
    flex: 1,
  },
  registerButton: {
    minHeight: 48,
    borderRadius: 11,
    backgroundColor: '#10108b',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  registerButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  disabledButton: { opacity: 0.45 },
  textButton: { alignSelf: 'center', marginTop: 20, padding: 8 },
  settingsToggle: { alignSelf: 'center', marginTop: 24, padding: 8 },
  urlRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  smallButton: {
    backgroundColor: '#10108b',
    minHeight: 46,
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  smallButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  footer: { color: '#858d98', textAlign: 'center', fontSize: 11, marginTop: 25, marginHorizontal: 20 },
});
