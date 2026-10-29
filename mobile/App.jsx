import { StatusBar } from 'expo-status-bar';
import * as Brightness from 'expo-brightness';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const REQUIRED_SAMPLES = 5;
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
  const [verificationStage, setVerificationStage] = useState('scanning');
  const [pictureSize, setPictureSize] = useState();
  const [now, setNow] = useState(Date.now());
  const cameraRef = useRef(null);
  const modeRef = useRef({ type: 'idle', sessionId: null });
  const busyRef = useRef(false);
  const previousBrightnessRef = useRef(null);

  const brightenScreen = useCallback(async () => {
    if (previousBrightnessRef.current !== null) return;
    if (!(await Brightness.isAvailableAsync())) {
      throw new Error('Automatic screen brightness is unavailable on this device.');
    }
    const previousBrightness = await Brightness.getBrightnessAsync();
    previousBrightnessRef.current = previousBrightness;
    await Brightness.setBrightnessAsync(1);
  }, []);

  const restoreScreenBrightness = useCallback(async () => {
    const previousBrightness = previousBrightnessRef.current;
    if (previousBrightness === null) return;
    previousBrightnessRef.current = null;
    try {
      await Brightness.setBrightnessAsync(previousBrightness);
    } catch (error) {
      setStatus(`Could not restore screen brightness: ${error.message}`);
    }
  }, []);

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

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        restoreScreenBrightness();
      } else if (modeRef.current.type === 'register') {
        brightenScreen().catch((error) => {
          setStatus(`Could not increase screen brightness: ${error.message}`);
        });
      }
    });
    return () => subscription.remove();
  }, [brightenScreen, restoreScreenBrightness]);

  useEffect(
    () => () => {
      const previousBrightness = previousBrightnessRef.current;
      if (previousBrightness !== null) {
        Brightness.setBrightnessAsync(previousBrightness).catch((error) => {
          console.warn(`Could not restore screen brightness: ${error.message}`);
        });
      }
    },
    [],
  );

  const stopFlow = useCallback(() => {
    const current = modeRef.current;
    modeRef.current = { type: 'idle', sessionId: null };
    setMode('idle');
    setCameraReady(false);
    restoreScreenBrightness();
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
  }, [apiUrl, restoreScreenBrightness]);

  const handleCameraReady = async () => {
    try {
      const sizes = await cameraRef.current?.getAvailablePictureSizesAsync();
      const target = (sizes || [])
        .map((size) => {
          const match = size.match(/^(\d+)x(\d+)$/);
          return match
            ? { size, width: Number(match[1]), height: Number(match[2]) }
            : null;
        })
        .filter((size) => size && size.width >= 640 && size.height >= 360)
        .sort((a, b) => a.width * a.height - b.width * b.height)[0];
      if (target) setPictureSize(target.size);
    } catch (error) {
      setStatus(`Using the camera's default picture size: ${error.message}`);
    } finally {
      setCameraReady(true);
    }
  };

  useEffect(() => {
    if (mode === 'idle' || !cameraReady) return undefined;
    const interval = mode === 'register' ? 160 : 100;
    const timer = setInterval(async () => {
      if (busyRef.current || !cameraRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const photo = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: 0.25,
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
            restoreScreenBrightness();
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
          if (result.status === 'matched' || result.status === 'blink_required') {
            setVerificationStage('matched');
            setStatus('Face matched. Blink once to record attendance.');
          } else {
            setVerificationStage('scanning');
            setStatus(result.message || 'Looking for your registered face…');
          }
          if (result.status === 'recorded') {
            modeRef.current = { type: 'idle', sessionId: null };
            setMode('idle');
            setCameraReady(false);
            setVerificationStage('scanning');
            setStatus(result.message || 'Attendance recorded.');
            await refreshStatus();
          }
        }
      } catch (error) {
        modeRef.current = { type: 'idle', sessionId: null };
        setMode('idle');
        setCameraReady(false);
        setStatus(error.message);
        restoreScreenBrightness();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }, interval);
    return () => clearInterval(timer);
  }, [apiUrl, cameraReady, mode, refreshStatus, restoreScreenBrightness]);

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
      let brightnessMessage = '';
      try {
        await brightenScreen();
      } catch (error) {
        brightnessMessage = ` Screen brightness could not be increased: ${error.message}`;
      }
      modeRef.current = { type: 'register', sessionId: null };
      setCameraReady(false);
      setProgress(0);
      setMode('register');
      setStatus(
        `Look at the camera while we capture ${REQUIRED_SAMPLES} samples.${brightnessMessage}`,
      );
    } catch (error) {
      setStatus(error.message);
      restoreScreenBrightness();
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
      setVerificationStage('scanning');
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
            <Text style={styles.brand}>APFD</Text>
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
                  pictureSize={pictureSize}
                  onCameraReady={handleCameraReady}
                  onMountError={(event) => setStatus(event.message || 'Could not start camera.')}
                />
                <View pointerEvents="none" style={styles.faceGuideOverlay}>
                  <View
                    style={[
                      styles.faceGuide,
                      mode === 'attendance' &&
                        verificationStage === 'matched' &&
                        styles.faceGuideMatched,
                    ]}
                  >
                    <View style={[styles.guideCorner, styles.guideTopLeft]} />
                    <View style={[styles.guideCorner, styles.guideTopRight]} />
                    <View style={[styles.guideCorner, styles.guideBottomLeft]} />
                    <View style={[styles.guideCorner, styles.guideBottomRight]} />
                  </View>
                  <View style={styles.guidePrompt}>
                    <Text style={styles.guidePromptText}>Fit your face inside the circle</Text>
                  </View>
                </View>
                <View style={styles.cameraBadge}>
                  {mode === 'attendance' && verificationStage === 'matched' ? (
                    <ActivityIndicator size="small" color="#a9edbd" />
                  ) : (
                    <View style={[styles.dot, busy && styles.dotActive]} />
                  )}
                  <Text style={styles.cameraBadgeText}>
                    {mode === 'register'
                      ? `Saving face ${progress}/${REQUIRED_SAMPLES}`
                      : verificationStage === 'matched'
                        ? 'Face matched · Verifying blink'
                        : 'Scanning for your face'}
                  </Text>
                </View>
                {mode === 'attendance' && verificationStage === 'matched' && (
                  <View style={styles.blinkPrompt}>
                    <ActivityIndicator color="#fff" size="small" />
                    <Text style={styles.blinkPromptText}>Blink once to record attendance</Text>
                  </View>
                )}
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
              Registration captures {REQUIRED_SAMPLES} samples in a few seconds. Face the camera and move slightly.
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

        <Text style={styles.footer}>
          Camera frames are sent only during registration or attendance verification.
        </Text>
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
  screen: { flex: 1, backgroundColor: '#f0f5f1' },
  content: { paddingBottom: 34 },
  header: {
    height: 305,
    backgroundColor: '#064f34',
    paddingTop: 30,
    paddingHorizontal: 22,
    overflow: 'hidden',
  },
  brandRow: { height: 96, justifyContent: 'center' },
  brand: { color: '#fff', fontSize: 42, fontWeight: '900', letterSpacing: 1 },
  brandTag: { color: '#b7ecc6', fontSize: 14, fontWeight: '700', letterSpacing: 5, marginLeft: 6 },
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
    backgroundColor: '#13884c',
    borderWidth: 3,
    borderColor: '#b7ecc6',
    opacity: 0.85,
  },
  attendanceCard: {
    marginTop: -38,
    marginHorizontal: 18,
    backgroundColor: '#fff',
    borderRadius: 20,
    minHeight: 310,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 82,
    shadowColor: '#075b3b',
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
  verticalRule: { width: 2, backgroundColor: '#d7e5da', marginVertical: 8 },
  progressRule: { height: 8, backgroundColor: '#cddbd0', marginTop: 12, marginBottom: 21 },
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
    backgroundColor: '#087344',
    borderColor: '#fff',
    borderWidth: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerValue: { color: '#fff', fontSize: 26, fontWeight: '700', lineHeight: 29 },
  timerUnit: { color: '#fff', fontSize: 10, marginBottom: 2 },
  cameraCard: {
    width: '86%',
    aspectRatio: 1,
    alignSelf: 'center',
    marginTop: 78,
    backgroundColor: '#10251a',
    borderRadius: 220,
    overflow: 'hidden',
    borderColor: '#087344',
    borderWidth: 5,
  },
  camera: { width: '100%', height: '100%' },
  faceGuideOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceGuide: {
    width: 236,
    height: 236,
    borderRadius: 118,
    borderWidth: 3,
    borderColor: '#dcffe5',
    backgroundColor: '#ffffff08',
    shadowColor: '#35ef78',
    shadowOpacity: 0.6,
    shadowRadius: 11,
    shadowOffset: { width: 0, height: 0 },
  },
  faceGuideMatched: { borderColor: '#35ef78', borderWidth: 4 },
  guideCorner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#50ee7f',
  },
  guideTopLeft: { top: -3, left: 18, borderTopWidth: 5, borderLeftWidth: 5, borderTopLeftRadius: 15 },
  guideTopRight: { top: -3, right: 18, borderTopWidth: 5, borderRightWidth: 5, borderTopRightRadius: 15 },
  guideBottomLeft: { bottom: -3, left: 18, borderBottomWidth: 5, borderLeftWidth: 5, borderBottomLeftRadius: 15 },
  guideBottomRight: { bottom: -3, right: 18, borderBottomWidth: 5, borderRightWidth: 5, borderBottomRightRadius: 15 },
  guidePrompt: {
    position: 'absolute',
    bottom: 62,
    borderRadius: 18,
    paddingHorizontal: 15,
    paddingVertical: 8,
    backgroundColor: '#063c29dd',
  },
  guidePromptText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  cameraBadge: {
    position: 'absolute',
    left: 12,
    top: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#063c29e8',
    borderRadius: 20,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#98a0ae' },
  dotActive: { backgroundColor: '#54dfa6' },
  cameraBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  blinkPrompt: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 63,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#087344ee',
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  blinkPromptText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  cancelButton: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    backgroundColor: '#087344',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  cancelButtonText: { color: '#fff', fontWeight: '700' },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 84,
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
    backgroundColor: '#087344',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickIconDisabled: { backgroundColor: '#9eaca1' },
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
  linkText: { color: '#087344', fontSize: 13, fontWeight: '700' },
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
  eventAction: { color: '#087344', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
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
    backgroundColor: '#087344',
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
    backgroundColor: '#087344',
    minHeight: 46,
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  smallButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  footer: { color: '#738078', textAlign: 'center', fontSize: 11, marginTop: 25, marginHorizontal: 20 },
});
