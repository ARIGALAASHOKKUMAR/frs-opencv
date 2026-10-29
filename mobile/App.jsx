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
import { isSupabaseConfigured, supabase } from './supabase';

const REQUIRED_SAMPLES = 5;
const DEFAULT_API_URL = 'https://frs-opencv.onrender.com';
const GREEN = '#006b43';
const DARK_GREEN = '#005639';
const BLUE = '#1269c7';
const PALE_BLUE = '#edf5fc';
const TURQUOISE = '#42d8d0';

async function requestApi(baseUrl, path, body, accessToken) {
  if (!accessToken) throw new Error('Sign in before using attendance features.');
  const headers = {};
  headers.Authorization = `Bearer ${accessToken}`;
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

function formatDate(value) {
  if (!value) return 'Today';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Today'
    : date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.floor(totalMinutes || 0));
  return {
    hours: String(Math.floor(minutes / 60)).padStart(2, '0'),
    minutes: String(minutes % 60).padStart(2, '0'),
  };
}

function initials(value) {
  return (value || 'AP')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [employeeId, setEmployeeId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState('sign-in');
  const [session, setSession] = useState(null);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState(null);
  const [events, setEvents] = useState([]);
  const [attendance, setAttendance] = useState({
    clocked_in: false,
    clock_in_time: null,
    clock_out_time: null,
    duration_minutes: 0,
  });
  const [page, setPage] = useState('splash');
  const [mode, setMode] = useState('idle');
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Connecting to attendance service…');
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [verificationStage, setVerificationStage] = useState('scanning');
  const [pictureSize, setPictureSize] = useState();
  const [now, setNow] = useState(Date.now());
  const [lastAction, setLastAction] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const cameraRef = useRef(null);
  const sessionRef = useRef(null);
  const modeRef = useRef({ type: 'idle', sessionId: null });
  const busyRef = useRef(false);
  const previousBrightnessRef = useRef(null);
  const returnPageRef = useRef('home');

  const refreshStatus = useCallback(async (activeSession = sessionRef.current) => {
    if (!activeSession?.access_token) throw new Error('Sign in to load your attendance data.');
    const result = await requestApi(
      apiUrl,
      '/api/status',
      undefined,
      activeSession.access_token,
    );
    setProfile(result.registered ? result.name : null);
    setName(result.name || '');
    setEmployeeId(result.employee_id || '');
    setEmail(result.email || '');
    setEvents(result.events || []);
    setAttendance({
      clocked_in: result.clocked_in || false,
      clock_in_time: result.clock_in_time || null,
      clock_out_time: result.clock_out_time || null,
      duration_minutes: result.duration_minutes || 0,
    });
    return result;
  }, [apiUrl]);

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

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setPage('login');
      setStatus('Set the Supabase URL and publishable key in mobile/.env, then restart Expo.');
      return undefined;
    }

    let active = true;
    const splashTimer = setTimeout(() => setPage('login'), 1600);
    supabase.auth.getSession().then(async ({ data, error }) => {
      if (!active) return;
      if (error) {
        setStatus(`Could not restore sign-in: ${error.message}`);
        setPage('login');
        return;
      }
      const restoredSession = data.session;
      sessionRef.current = restoredSession;
      setSession(restoredSession);
      setPage(restoredSession ? 'home' : 'login');
      if (restoredSession) {
        try {
          const result = await refreshStatus(restoredSession);
          if (active) {
            setStatus(
              result.registered
                ? `Welcome back, ${result.name}.`
                : 'Register your face to get started.',
            );
          }
        } catch (statusError) {
          if (active) setStatus(statusError.message);
        }
      }
    });
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const hadSession = Boolean(sessionRef.current);
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (!nextSession) {
        if (hadSession) setPage('login');
        setProfile(null);
        setEvents([]);
        setName('');
        setEmployeeId('');
        setEmail('');
      }
    });
    return () => {
      active = false;
      clearTimeout(splashTimer);
      authListener.subscription.unsubscribe();
    };
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
      requestApi(apiUrl, '/api/register/cancel', {}, session?.access_token).catch((error) => {
        setStatus(`Stopped on this device. Could not cancel on the server: ${error.message}`);
      });
    } else if (current.type === 'attendance' && current.sessionId) {
      requestApi(apiUrl, '/api/attendance/cancel', {
        session_id: current.sessionId,
      }, session?.access_token).catch((error) => {
        setStatus(`Stopped on this device. Could not cancel on the server: ${error.message}`);
      });
    }
  }, [apiUrl, restoreScreenBrightness, session]);

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
        .filter((size) => size && size.width >= 480 && size.height >= 320)
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
          quality: 0.2,
          skipProcessing: true,
        });
        if (!photo?.base64) throw new Error('The camera did not return an image.');

        const current = modeRef.current;
        if (current.type === 'register') {
          const result = await requestApi(apiUrl, '/api/register/frame', {
            image: photo.base64,
          }, sessionRef.current?.access_token);
          if (result.status === 'registered') {
            modeRef.current = { type: 'idle', sessionId: null };
            setMode('idle');
            setCameraReady(false);
            setProgress(REQUIRED_SAMPLES);
            setProfile(result.name);
            setStatus(`Face registration complete for ${result.name}.`);
            restoreScreenBrightness();
            await refreshStatus();
            setPage('profile');
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
          }, sessionRef.current?.access_token);
          if (result.status === 'matched' || result.status === 'blink_required') {
            setVerificationStage('matched');
            setPage('processing');
            setStatus('Face matched. Blink once to record attendance.');
          } else if (result.status !== 'recorded') {
            setVerificationStage('scanning');
            setPage('camera');
            setStatus(result.message || 'Looking for your registered face…');
          }
          if (result.status === 'recorded') {
            setLastAction(result);
            modeRef.current = { type: 'idle', sessionId: null };
            setMode('idle');
            setCameraReady(false);
            setVerificationStage('scanning');
            setStatus(result.message || 'Attendance recorded.');
            await refreshStatus();
            setPage('success');
          }
        }
      } catch (error) {
        modeRef.current = { type: 'idle', sessionId: null };
        setMode('idle');
        setCameraReady(false);
        setStatus(error.message);
        restoreScreenBrightness();
        setPage(returnPageRef.current);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }, interval);
    return () => clearInterval(timer);
  }, [apiUrl, cameraReady, mode, refreshStatus, restoreScreenBrightness]);

  const handleLogin = async () => {
    Keyboard.dismiss();
    if (!supabase || !isSupabaseConfigured) {
      setStatus('Supabase is not configured. Set mobile/.env and restart Expo.');
      return;
    }
    if (
      !email.trim()
      || !password
      || (authMode === 'sign-up' && (!employeeId.trim() || !name.trim()))
    ) {
      Alert.alert(
        'Complete the form',
        authMode === 'sign-up'
          ? 'Enter your name, employee ID, email, and password.'
          : 'Enter your email and password.',
      );
      return;
    }

    setLoading(true);
    try {
      if (authMode === 'sign-up') {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              full_name: name.trim(),
              employee_id: employeeId.trim(),
            },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setAuthMode('sign-in');
          setStatus('Account created. Check your email to confirm it, then sign in.');
          Alert.alert(
            'Confirm your email',
            'Supabase created the account. Open the confirmation email, then sign in.',
          );
          return;
        }
        sessionRef.current = data.session;
        setSession(data.session);
        setPage('home');
        setStatus('Account created. Register your face from your profile.');
        await refreshStatus(data.session);
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        sessionRef.current = data.session;
        setSession(data.session);
        setPage('home');
        const result = await refreshStatus(data.session);
        setStatus(
          result.registered
            ? `Welcome back, ${result.name}.`
            : 'Sign-in successful. Register your face from your profile.',
        );
      }
    } catch (error) {
      setStatus(error.message || 'Could not complete sign-in.');
    } finally {
      setLoading(false);
    }
  };

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
    const registrationName = name.trim() || profile || employeeId.trim();
    if (!registrationName || !employeeId.trim()) {
      Alert.alert('Profile details required', 'Enter your full name and employee ID first.');
      return;
    }
    if (!(await ensureCameraPermission())) return;
    setLoading(true);
    try {
      await requestApi(
        apiUrl,
        '/api/register/start',
        { name: registrationName, employee_id: employeeId.trim() },
        session?.access_token,
      );
      let brightnessMessage = '';
      try {
        await brightenScreen();
      } catch (error) {
        brightnessMessage = ` Screen brightness could not be increased: ${error.message}`;
      }
      returnPageRef.current = page === 'camera' ? 'profile' : page;
      modeRef.current = { type: 'register', sessionId: null };
      setCameraReady(false);
      setProgress(0);
      setMode('register');
      setPage('camera');
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
      setPage('profile');
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
      const result = await requestApi(
        apiUrl,
        '/api/attendance/start',
        { action },
        session?.access_token,
      );
      returnPageRef.current = 'home';
      modeRef.current = { type: 'attendance', sessionId: result.session_id };
      setVerificationStage('scanning');
      setCameraReady(false);
      setMode('attendance');
      setPage('camera');
      setStatus(`Ready for ${action}. Look at the camera, then blink to record.`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  };

  const onCancel = () => {
    stopFlow();
    setPage(returnPageRef.current);
    setStatus('Cancelled.');
  };

  const handleLogout = async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      sessionRef.current = null;
      setSession(null);
      setProfile(null);
      setEvents([]);
      setName('');
      setEmployeeId('');
      setEmail('');
      setAttendance({
        clocked_in: false,
        clock_in_time: null,
        clock_out_time: null,
        duration_minutes: 0,
      });
      setPassword('');
      setAuthMode('sign-in');
      setPage('login');
    } catch (error) {
      setStatus(`Could not sign out: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleNavigation = (target) => {
    if (mode !== 'idle') return;
    if (target === 'profile') setPage('profile');
    else if (target === 'history') setPage('history');
    else setPage('home');
  };

  const cameraActive = mode !== 'idle';
  const shiftDuration = attendance.clocked_in && attendance.clock_in_time
    ? Math.max(0, Math.floor((now - new Date(attendance.clock_in_time).getTime()) / 60000))
    : attendance.duration_minutes;
  const duration = formatDuration(shiftDuration);
  const activeAction = attendance.clocked_in ? 'clock-out' : 'clock-in';
  const recentEvents = events.slice(0, 10);

  if (page === 'splash') {
    return (
      <View style={styles.splash}>
        <StatusBar style="light" />
        <ForestCanopy />
        <TreeLogo large />
        <Text style={styles.splashTitle}>AP Forest Department</Text>
        <Text style={styles.splashTagline}>Secure  •  Green  •  Smarter</Text>
        <View style={styles.splashBottom}>
          <View style={styles.splashProgress} />
          <Text style={styles.splashCaption}>Face Recognition Attendance</Text>
        </View>
      </View>
    );
  }

  if (page === 'login') {
    return (
      <View style={styles.loginScreen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.loginContent} keyboardShouldPersistTaps="handled">
          <ForestFooter />
          <View style={styles.loginBrand}>
            <TreeLogo />
            <Text style={styles.loginTitle}>AP Forest Department</Text>
            <Text style={styles.loginSubtitle}>
              {authMode === 'sign-up' ? 'Create your employee account' : 'Face Recognition System'}
            </Text>
          </View>
          <View style={styles.loginForm}>
            {authMode === 'sign-up' && (
              <>
                <InputWithIcon icon="♙">
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="Full name"
                    placeholderTextColor="#9aa5b2"
                    autoCapitalize="words"
                    style={styles.loginInput}
                    returnKeyType="next"
                  />
                </InputWithIcon>
                <InputWithIcon icon="♙">
                  <TextInput
                    value={employeeId}
                    onChangeText={setEmployeeId}
                    placeholder="Employee ID  ·  e.g. APF1234"
                    placeholderTextColor="#9aa5b2"
                    autoCapitalize="characters"
                    style={styles.loginInput}
                    returnKeyType="next"
                  />
                </InputWithIcon>
              </>
            )}
            <InputWithIcon icon="✉">
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="Email address"
                placeholderTextColor="#9aa5b2"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={styles.loginInput}
                returnKeyType="next"
              />
            </InputWithIcon>
            <InputWithIcon icon="♙">
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor="#9aa5b2"
                secureTextEntry
                style={styles.loginInput}
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
              <Text style={styles.passwordEye}>◉</Text>
            </InputWithIcon>
            {authMode === 'sign-in' && (
              <View style={styles.loginOptions}>
                <Text style={styles.rememberText}>Sign in securely with Supabase</Text>
                <Text style={styles.forgotText}>Email account</Text>
              </View>
            )}
            <Pressable
              style={[styles.loginButton, loading && styles.disabledButton]}
              onPress={handleLogin}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.loginButtonText}>
                  {authMode === 'sign-up' ? 'Create Account' : 'Login'}
                </Text>
              )}
            </Pressable>
            <View style={styles.orRow}>
              <View style={styles.orLine} />
              <Text style={styles.orText}>or</Text>
              <View style={styles.orLine} />
            </View>
            <Pressable
              style={styles.biometricButton}
              onPress={() => setAuthMode(authMode === 'sign-in' ? 'sign-up' : 'sign-in')}
            >
              <View style={styles.fingerprint}>
                <Text style={styles.fingerprintGlyph}>◎</Text>
              </View>
              <Text style={styles.biometricText}>
                {authMode === 'sign-in' ? 'Create a new account' : 'Already registered? Sign in'}
              </Text>
            </Pressable>
            <Text style={styles.demoNote}>
              {isSupabaseConfigured
                ? status
                : 'Supabase settings are missing. Configure mobile/.env and restart Expo.'}
            </Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (cameraActive && (page === 'camera' || page === 'processing')) {
    return (
      <View style={[styles.cameraScreen, page === 'processing' && styles.processingScreen]}>
        <StatusBar style="light" />
        {page === 'camera' && (
          <View style={styles.cameraHeader}>
            <Pressable onPress={onCancel} style={styles.backButton}>
              <Text style={styles.backGlyph}>‹</Text>
            </Pressable>
            <Text style={styles.cameraHeaderTitle}>
              {mode === 'register' ? 'Register Face' : 'Mark Attendance'}
            </Text>
            <View style={styles.headerSpacer} />
          </View>
        )}
        <View style={page === 'camera' ? styles.cameraBody : styles.processingBody}>
          <View
            style={[
              styles.attendanceToggle,
              (page !== 'camera' || mode !== 'attendance') && styles.hidden,
            ]}
          >
            <View
              style={[
                styles.toggleChoice,
                activeAction === 'clock-in' && styles.toggleChoiceActive,
              ]}
            >
              <Text
                style={[
                  styles.toggleText,
                  activeAction === 'clock-in' && styles.toggleTextActive,
                ]}
              >
                Check In
              </Text>
            </View>
            <View
              style={[
                styles.toggleChoice,
                activeAction === 'clock-out' && styles.toggleChoiceActive,
              ]}
            >
              <Text
                style={[
                  styles.toggleText,
                  activeAction === 'clock-out' && styles.toggleTextActive,
                ]}
              >
                Check Out
              </Text>
            </View>
          </View>
          <View style={page === 'camera' ? styles.facePreview : styles.processingCamera}>
            {permission?.granted ? (
              <CameraView
                ref={cameraRef}
                style={styles.camera}
                facing="front"
                pictureSize={pictureSize}
                onCameraReady={handleCameraReady}
                onMountError={(event) => {
                  setStatus(event.message || 'Could not start camera.');
                  setMode('idle');
                  modeRef.current = { type: 'idle', sessionId: null };
                  setPage(returnPageRef.current);
                }}
              />
            ) : (
              <ActivityIndicator color={GREEN} />
            )}
            {page === 'camera' ? (
              <View pointerEvents="none" style={styles.faceGuideOverlay}>
                <View
                  style={[
                    styles.faceGuide,
                    verificationStage === 'matched' && styles.faceGuideMatched,
                  ]}
                >
                  <View style={[styles.guideCorner, styles.guideTopLeft]} />
                  <View style={[styles.guideCorner, styles.guideTopRight]} />
                  <View style={[styles.guideCorner, styles.guideBottomLeft]} />
                  <View style={[styles.guideCorner, styles.guideBottomRight]} />
                </View>
              </View>
            ) : (
              <>
                <View pointerEvents="none" style={styles.processingDim} />
                <View pointerEvents="none" style={styles.processingRing}>
                  <View style={styles.processingFocus}>
                    <Text style={styles.processingFace}>◎</Text>
                  </View>
                </View>
              </>
            )}
          </View>
          {page === 'camera' ? (
            <>
              <Text style={styles.facePrompt}>
                {mode === 'register' ? 'Position your face inside the frame' : 'Position your face within the frame'}
              </Text>
              <Text style={styles.faceSubPrompt}>
                {mode === 'register'
                  ? 'Keep your face centered while we capture a few samples'
                  : 'Make sure your face is clearly visible'}
              </Text>
              {mode === 'attendance' && (
                <View style={styles.tipsRow}>
                  <CameraTip icon="☼" label="Good Lighting" />
                  <CameraTip icon="◉" label="Remove Mask" />
                  <CameraTip icon="◉" label="Look at Camera" />
                </View>
              )}
              {mode === 'register' && (
                <Text style={styles.registrationProgress}>
                  Capturing face samples  ·  {progress}/{REQUIRED_SAMPLES}
                </Text>
              )}
              <Text style={styles.cameraStatus}>
                {status}
              </Text>
              <Pressable style={styles.cameraCancel} onPress={onCancel}>
                <Text style={styles.cameraCancelText}>Cancel</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator size="large" color={TURQUOISE} style={styles.processingSpinner} />
          )}
          {page === 'processing' && (
            <>
              <Text style={styles.processingTitle}>Processing...</Text>
              <Text style={styles.processingCopy}>Please wait while we verify your face.</Text>
              <Text style={styles.processingBlink}>Blink once to complete verification</Text>
              <Pressable style={styles.processingCancel} onPress={onCancel}>
                <Text style={styles.cameraCancelText}>Cancel</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    );
  }

  if (page === 'success') {
    return (
      <View style={styles.successScreen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.successContent}>
          <View style={styles.successCheck}>
            <Text style={styles.successCheckText}>✓</Text>
          </View>
          <Text style={styles.successTitle}>Attendance Marked</Text>
          <Text style={styles.successTitle}>Successfully!</Text>
          <View style={styles.successProfile}>
            <Avatar name={profile || 'APFD User'} large />
            <View style={styles.successProfileText}>
              <Text style={styles.successName}>{profile || 'APFD User'}</Text>
              <Text style={styles.successMeta}>Employee ID: {employeeId || 'APF1234'}</Text>
              <Text style={styles.successMeta}>Forest Range Officer</Text>
            </View>
          </View>
          <DetailRow
            icon="◷"
            label={lastAction?.action === 'clock-out' ? 'Check Out Time' : 'Check In Time'}
            value={formatTime(lastAction?.timestamp || attendance.clock_in_time)}
          />
          <DetailRow
            icon="▦"
            label="Date"
            value={formatDate(lastAction?.timestamp || attendance.clock_in_time)}
          />
          <DetailRow icon="♧" label="Location" value="Range Office, Mangalagiri" />
          <Pressable style={styles.successButton} onPress={() => setPage('home')}>
            <Text style={styles.successButtonText}>Done</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  if (page === 'history') {
    return (
      <View style={styles.appScreen}>
        <StatusBar style="dark" />
        <View style={styles.simpleHeader}>
          <Pressable style={styles.simpleBack} onPress={() => setPage('home')}>
            <Text style={styles.backDark}>‹</Text>
          </Pressable>
          <Text style={styles.simpleTitle}>Attendance History</Text>
          <Pressable style={styles.headerIcon} onPress={connect}>
            {loading ? <ActivityIndicator color={GREEN} /> : <Text style={styles.headerIconText}>⌕</Text>}
          </Pressable>
        </View>
        <ScrollView style={styles.pageScroll} contentContainerStyle={styles.historyContent}>
          <View style={styles.monthPicker}>
            <Text style={styles.monthArrow}>‹</Text>
            <Text style={styles.monthTitle}>
              {new Date().toLocaleDateString([], { month: 'long', year: 'numeric' })}
            </Text>
            <Text style={styles.monthArrow}>›</Text>
          </View>
          <View style={styles.historyStats}>
            <StatCard label="Present" value={events.length ? '1' : '0'} tone="green" />
            <StatCard label="Absent" value="0" tone="red" />
            <StatCard label="On Leave" value="0" tone="blue" />
          </View>
          <View style={styles.historyList}>
            {recentEvents.length === 0 ? (
              <View style={styles.emptyHistory}>
                <Text style={styles.emptyHistoryIcon}>▤</Text>
                <Text style={styles.emptyHistoryTitle}>No attendance yet</Text>
                <Text style={styles.emptyHistoryCopy}>Your clock-in and clock-out records will appear here.</Text>
              </View>
            ) : (
              recentEvents.map((event, index) => {
                const isClockIn = event.action === 'clock-in';
                return (
                  <View style={styles.historyRow} key={`${event.timestamp}-${index}`}>
                    <View style={styles.historyDate}>
                      <Text style={styles.historyDateText}>{formatDate(event.timestamp)}</Text>
                    </View>
                    <Text style={styles.historyTime}>{formatTime(event.timestamp)}</Text>
                    <Text
                      style={[
                        styles.historyAction,
                        isClockIn ? styles.historyIn : styles.historyOut,
                      ]}
                    >
                      {isClockIn ? 'Check In' : 'Check Out'}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
          <Pressable style={styles.refreshLink} onPress={connect}>
            <Text style={styles.refreshLinkText}>Refresh attendance records</Text>
          </Pressable>
        </ScrollView>
        <BottomNav active="history" onSelect={handleNavigation} />
      </View>
    );
  }

  if (page === 'profile') {
    return (
      <View style={styles.appScreen}>
        <StatusBar style="dark" />
        <View style={styles.simpleHeader}>
          <Pressable style={styles.simpleBack} onPress={() => setPage('home')}>
            <Text style={styles.backDark}>‹</Text>
          </Pressable>
          <Text style={styles.simpleTitle}>My Profile</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView style={styles.pageScroll} contentContainerStyle={styles.profileContent}>
          <View style={styles.profileCard}>
            <Avatar name={profile || employeeId || 'APFD User'} large />
            <View style={styles.profileCardText}>
              <Text style={styles.profileName}>{profile || 'Register your face'}</Text>
              <Text style={styles.profileMeta}>Employee ID: {employeeId || 'APF1234'}</Text>
              <Text style={styles.profileMeta}>{session?.user?.email || email}</Text>
              <Text style={styles.profileMeta}>Forest Range Officer</Text>
              {profile && (
                <Pressable style={styles.editProfileButton} onPress={startRegistration}>
                  <Text style={styles.editProfileText}>Edit Face Profile</Text>
                </Pressable>
              )}
            </View>
          </View>
          {!profile && (
            <View style={styles.registrationCard}>
              <Text style={styles.sectionTitle}>Face Recognition</Text>
              <Text style={styles.helpText}>
                Register one face to enable secure clock-in and clock-out.
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Enter your name"
                placeholderTextColor="#9aa5b2"
                style={styles.profileInput}
              />
              <PrimaryButton title="Register Face" onPress={startRegistration} loading={loading} />
            </View>
          )}
          {profile && (
            <View style={styles.profileRows}>
              <ProfileRow icon="♙" title="Personal Details" subtitle={employeeId || 'APF1234'} />
              <ProfileRow
                icon="◉"
                title="Face Recognition"
                subtitle="Registered"
                accessoryColor={GREEN}
                onPress={startRegistration}
              />
              <ProfileRow icon="▤" title="Attendance History" onPress={() => setPage('history')} />
              <ProfileRow icon="♧" title="Leave Requests" subtitle="Apply / Status" />
              <ProfileRow icon="⚙" title="Settings" onPress={() => setShowSettings(!showSettings)} />
              <ProfileRow icon="?" title="Help & Support" />
              <ProfileRow
                icon="↪"
                title="Logout"
                destructive
                onPress={handleLogout}
              />
            </View>
          )}
          {showSettings && (
            <View style={styles.registrationCard}>
              <Text style={styles.sectionTitle}>Attendance API</Text>
              <View style={styles.settingsRow}>
                <TextInput
                  value={apiUrl}
                  onChangeText={setApiUrl}
                  placeholder={DEFAULT_API_URL}
                  placeholderTextColor="#9aa5b2"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  style={styles.profileInput}
                />
                <Pressable style={styles.connectButton} onPress={connect} disabled={loading}>
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.connectText}>Connect</Text>}
                </Pressable>
              </View>
              <Text style={styles.apiStatus}>{status}</Text>
            </View>
          )}
          {profile && (
            <Pressable style={styles.linkButton} onPress={startRegistration}>
              <Text style={styles.linkButtonText}>Update registered face</Text>
            </Pressable>
          )}
          <Text style={styles.demoFootnote}>
            Account sign-in is handled by Supabase. Face models and attendance belong to this account.
          </Text>
        </ScrollView>
        <BottomNav active="profile" onSelect={handleNavigation} />
      </View>
    );
  }

  return (
    <View style={styles.appScreen}>
      <StatusBar style="light" />
      <ScrollView style={styles.pageScroll} contentContainerStyle={styles.homeContent}>
        <View style={styles.dashboardHeader}>
          <View style={styles.dashboardTopRow}>
            <Avatar name={profile || employeeId || 'APFD User'} />
            <View style={styles.greetingBlock}>
              <Text style={styles.greeting}>Good Morning,</Text>
              <Text style={styles.greetingName}>{profile || employeeId || 'APFD Officer'}</Text>
              <Text style={styles.greetingRole}>Forest Range Officer</Text>
            </View>
            <Pressable style={styles.notificationButton} onPress={() => setStatus('You are all caught up.')}>
              <Text style={styles.notificationGlyph}>♟</Text>
              <View style={styles.notificationDot} />
            </Pressable>
          </View>
          <View style={styles.clockHero}>
            <View style={styles.heroDecorCircle} />
            <Text style={styles.heroDate}>
              {new Date(now).toLocaleDateString([], {
                weekday: 'short',
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </Text>
            <Text style={styles.heroTime}>
              {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
            <Pressable
              style={[styles.markAttendanceButton, !profile && styles.markAttendanceDisabled]}
              onPress={() => startAttendance(activeAction)}
              disabled={!profile || loading || cameraActive}
            >
              {loading ? <ActivityIndicator color={GREEN} /> : <Text style={styles.markAttendanceText}>▣  Mark Attendance</Text>}
            </Pressable>
            {!profile && (
              <Pressable style={styles.registerPrompt} onPress={() => setPage('profile')}>
                <Text style={styles.registerPromptText}>Register your face to get started</Text>
              </Pressable>
            )}
          </View>
        </View>
        <View style={styles.homeBody}>
          <View style={styles.shiftSummary}>
            <View style={styles.shiftSummaryTop}>
              <View>
                <Text style={styles.summaryEyebrow}>TODAY'S ATTENDANCE</Text>
                <Text style={styles.summaryStatus}>
                  {attendance.clocked_in ? 'You are on duty' : 'Ready when you are'}
                </Text>
              </View>
              <View style={[styles.onDutyBadge, attendance.clocked_in && styles.onDutyBadgeActive]}>
                <Text style={styles.onDutyBadgeText}>{attendance.clocked_in ? 'ON DUTY' : 'OFF DUTY'}</Text>
              </View>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryTimes}>
              <View>
                <Text style={styles.summaryLabel}>CHECK IN</Text>
                <Text style={styles.summaryTime}>{formatTime(attendance.clock_in_time)}</Text>
              </View>
              <View style={styles.summaryClock}>
                <Text style={styles.summaryHours}>{duration.hours}</Text>
                <Text style={styles.summaryUnit}>HRS</Text>
              </View>
              <View style={styles.summaryRight}>
                <Text style={styles.summaryLabel}>CHECK OUT</Text>
                <Text style={styles.summaryTime}>{formatTime(attendance.clock_out_time)}</Text>
              </View>
            </View>
          </View>

          <Text style={styles.quickTitle}>Quick access</Text>
          <View style={styles.dashboardGrid}>
            <DashboardTile icon="▦" title="Attendance" subtitle="View records" onPress={() => setPage('history')} />
            <DashboardTile icon="♙" title="Profile" subtitle="My details" onPress={() => setPage('profile')} />
            <DashboardTile icon="▤" title="Leave" subtitle="Apply / Status" onPress={() => setStatus('Leave requests are not enabled in this demo.')} />
            <DashboardTile icon="♟" title="Notifications" subtitle="Alerts" onPress={() => setStatus('You are all caught up.')} />
          </View>
          <View style={styles.recentHeading}>
            <Text style={styles.quickTitle}>Recent activity</Text>
            <Pressable onPress={() => setPage('history')}>
              <Text style={styles.viewAll}>View all</Text>
            </Pressable>
          </View>
          {recentEvents.length === 0 ? (
            <View style={styles.emptyActivity}>
              <Text style={styles.emptyActivityText}>Your attendance records will appear here.</Text>
            </View>
          ) : (
            recentEvents.slice(0, 3).map((event, index) => (
              <View style={styles.activityRow} key={`${event.timestamp}-${index}`}>
                <View style={[styles.activityIcon, event.action === 'clock-in' ? styles.iconGreen : styles.iconRed]}>
                  <Text style={styles.activityIconText}>{event.action === 'clock-in' ? '↗' : '↙'}</Text>
                </View>
                <View style={styles.activityInfo}>
                  <Text style={styles.activityName}>{event.action === 'clock-in' ? 'Check In' : 'Check Out'}</Text>
                  <Text style={styles.activityDate}>{formatDate(event.timestamp)}</Text>
                </View>
                <Text style={styles.activityTime}>{formatTime(event.timestamp)}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
      <BottomNav active="home" onSelect={handleNavigation} />
    </View>
  );
}

function TreeLogo({ large = false }) {
  return (
    <View style={[styles.logoCircle, large && styles.logoCircleLarge]}>
      <View style={styles.treeCrownTop} />
      <View style={styles.treeCrownMid} />
      <View style={styles.treeCrownBottom} />
      <View style={styles.treeTrunk} />
      <View style={styles.treeBase} />
    </View>
  );
}

function ForestCanopy() {
  return (
    <View pointerEvents="none" style={styles.forestCanopy}>
      <View style={[styles.canopyCircle, styles.canopyOne]} />
      <View style={[styles.canopyCircle, styles.canopyTwo]} />
      <View style={[styles.canopyCircle, styles.canopyThree]} />
      <View style={[styles.canopyCircle, styles.canopyFour]} />
      <View style={styles.canopyGround} />
    </View>
  );
}

function ForestFooter() {
  return (
    <View pointerEvents="none" style={styles.forestFooter}>
      <View style={styles.footerHillBack} />
      <View style={styles.footerHillFront} />
      <View style={styles.footerTrees}>
        {Array.from({ length: 11 }).map((_, index) => (
          <View
            key={index}
            style={[styles.footerTree, { borderBottomWidth: 28 + ((index * 17) % 46) }]}
          />
        ))}
      </View>
    </View>
  );
}

function Avatar({ name, large = false }) {
  return (
    <View style={[styles.avatar, large && styles.avatarLarge]}>
      <Text style={[styles.avatarText, large && styles.avatarTextLarge]}>{initials(name)}</Text>
    </View>
  );
}

function InputWithIcon({ icon, children }) {
  return (
    <View style={styles.loginInputWrap}>
      <Text style={styles.inputIcon}>{icon}</Text>
      {children}
    </View>
  );
}

function CameraTip({ icon, label }) {
  return (
    <View style={styles.cameraTip}>
      <View style={styles.tipIconCircle}>
        <Text style={styles.tipIcon}>{icon}</Text>
      </View>
      <Text style={styles.tipText}>{label}</Text>
    </View>
  );
}

function BottomNav({ active, onSelect }) {
  const items = [
    { key: 'home', title: 'Home', icon: '⌂' },
    { key: 'history', title: 'Attendance', icon: '▤' },
    { key: 'profile', title: 'Profile', icon: '♙' },
    { key: 'more', title: 'More', icon: '☰' },
  ];
  return (
    <View style={styles.bottomNav}>
      {items.map((item) => (
        <Pressable
          key={item.key}
          style={styles.navItem}
          onPress={() => onSelect(item.key === 'more' ? 'profile' : item.key)}
        >
          <Text style={[styles.navIcon, active === item.key && styles.navActive]}>{item.icon}</Text>
          <Text style={[styles.navLabel, active === item.key && styles.navActive]}>{item.title}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function DashboardTile({ icon, title, subtitle, onPress }) {
  return (
    <Pressable style={styles.dashboardTile} onPress={onPress}>
      <View style={styles.tileIcon}>
        <Text style={styles.tileIconText}>{icon}</Text>
      </View>
      <View>
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileSubtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <View style={[styles.statCard, styles[`stat${tone}`]]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, styles[`statValue${tone}`]]}>{value}</Text>
    </View>
  );
}

function DetailRow({ icon, label, value }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailIcon}>{icon}</Text>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function ProfileRow({ icon, title, subtitle, onPress, accessoryColor, destructive = false }) {
  return (
    <Pressable style={styles.profileRow} onPress={onPress}>
      <Text style={[styles.profileRowIcon, destructive && styles.destructiveText]}>{icon}</Text>
      <View style={styles.profileRowBody}>
        <Text style={[styles.profileRowTitle, destructive && styles.destructiveText]}>{title}</Text>
        {subtitle ? <Text style={[styles.profileRowSubtitle, accessoryColor && { color: accessoryColor }]}>{subtitle}</Text> : null}
      </View>
      <Text style={styles.profileChevron}>›</Text>
    </Pressable>
  );
}

function PrimaryButton({ title, onPress, loading = false }) {
  return (
    <Pressable style={styles.primaryButton} onPress={onPress} disabled={loading}>
      {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#073c2b',
    overflow: 'hidden',
  },
  forestCanopy: { ...StyleSheet.absoluteFillObject, opacity: 0.95 },
  canopyCircle: { position: 'absolute', backgroundColor: '#0e5a3b', borderRadius: 999 },
  canopyOne: { width: 330, height: 330, top: -80, left: -90, backgroundColor: '#4c7f87' },
  canopyTwo: { width: 280, height: 370, top: 20, right: -85, backgroundColor: '#174e46' },
  canopyThree: { width: 360, height: 350, bottom: 20, left: -130, backgroundColor: '#0c5237' },
  canopyFour: { width: 300, height: 340, bottom: -30, right: -100, backgroundColor: '#092f24' },
  canopyGround: { ...StyleSheet.absoluteFillObject, backgroundColor: '#002a1b66' },
  splashTitle: { color: '#fff', fontSize: 24, fontWeight: '700', marginTop: 16 },
  splashTagline: { color: '#e5f4ec', fontSize: 14, marginTop: 8 },
  splashBottom: { position: 'absolute', bottom: 45, alignItems: 'center' },
  splashProgress: { width: 74, height: 3, borderRadius: 2, backgroundColor: '#d8efe0', marginBottom: 15 },
  splashCaption: { color: '#fff', fontSize: 12 },
  logoCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoCircleLarge: { width: 94, height: 94, borderRadius: 47, borderColor: '#cdebd7' },
  treeCrownTop: {
    position: 'absolute',
    top: 15,
    width: 19,
    height: 19,
    borderRadius: 11,
    backgroundColor: GREEN,
  },
  treeCrownMid: {
    position: 'absolute',
    top: 25,
    width: 35,
    height: 24,
    borderRadius: 15,
    backgroundColor: GREEN,
  },
  treeCrownBottom: {
    position: 'absolute',
    top: 37,
    width: 49,
    height: 21,
    borderRadius: 15,
    backgroundColor: GREEN,
  },
  treeTrunk: {
    position: 'absolute',
    top: 43,
    width: 6,
    height: 20,
    borderRadius: 3,
    backgroundColor: '#735233',
  },
  treeBase: {
    position: 'absolute',
    bottom: 10,
    width: 52,
    height: 2,
    backgroundColor: GREEN,
  },
  loginScreen: { flex: 1, backgroundColor: '#fbfcfc' },
  loginContent: { flexGrow: 1, paddingTop: 66, paddingBottom: 38, justifyContent: 'center' },
  loginBrand: { alignItems: 'center', marginBottom: 28 },
  loginTitle: { color: '#17243a', fontSize: 21, fontWeight: '800', marginTop: 10 },
  loginSubtitle: { color: '#59677b', fontSize: 13, marginTop: 4 },
  loginForm: { marginHorizontal: 24, gap: 12 },
  loginInputWrap: {
    minHeight: 50,
    borderRadius: 10,
    borderColor: '#dce3e9',
    borderWidth: 1,
    backgroundColor: '#ffffffd9',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputIcon: { fontSize: 17, color: '#526276', width: 25 },
  loginInput: { flex: 1, color: '#202c3b', fontSize: 13, paddingVertical: 11 },
  passwordEye: { color: '#59677b', fontSize: 17, paddingHorizontal: 4 },
  loginOptions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 1 },
  rememberText: { color: '#354153', fontSize: 11 },
  forgotText: { color: '#176de0', fontSize: 11, fontWeight: '600' },
  loginButton: {
    height: 49,
    borderRadius: 9,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 3,
  },
  loginButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 0 },
  orLine: { flex: 1, height: 1, backgroundColor: '#e2e7eb' },
  orText: { color: '#8994a1', fontSize: 11 },
  biometricButton: { alignItems: 'center', paddingTop: 2 },
  fingerprint: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderColor: '#1770ef',
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fingerprintGlyph: { color: '#1770ef', fontSize: 33, lineHeight: 39 },
  biometricText: { color: '#3c4756', fontSize: 11, marginTop: 6 },
  demoNote: { color: '#86919c', textAlign: 'center', fontSize: 10, marginTop: 6 },
  forestFooter: { position: 'absolute', height: 178, bottom: 0, left: 0, right: 0, overflow: 'hidden' },
  footerHillBack: {
    position: 'absolute',
    width: '130%',
    height: 130,
    borderRadius: 120,
    bottom: -72,
    left: '-15%',
    backgroundColor: '#e4f2ee',
  },
  footerHillFront: {
    position: 'absolute',
    width: '145%',
    height: 100,
    borderRadius: 100,
    bottom: -65,
    left: '-20%',
    backgroundColor: '#d6eae3',
  },
  footerTrees: { position: 'absolute', bottom: 8, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end' },
  footerTree: {
    width: 0,
    height: 0,
    borderLeftWidth: 12,
    borderRightWidth: 12,
    borderBottomWidth: 40,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#bdd8ce',
    opacity: 0.6,
  },
  appScreen: { flex: 1, backgroundColor: '#f5f8fb' },
  pageScroll: { flex: 1 },
  homeContent: { paddingBottom: 20 },
  dashboardHeader: {
    backgroundColor: BLUE,
    paddingTop: 52,
    paddingHorizontal: 18,
    paddingBottom: 28,
    overflow: 'hidden',
  },
  dashboardTopRow: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 43,
    height: 43,
    borderRadius: 22,
    backgroundColor: '#d7e5df',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#ffffffb0',
  },
  avatarLarge: { width: 68, height: 68, borderRadius: 18, borderColor: '#edf2f6', borderWidth: 1 },
  avatarText: { color: DARK_GREEN, fontWeight: '800', fontSize: 14 },
  avatarTextLarge: { fontSize: 20 },
  greetingBlock: { flex: 1, marginLeft: 10 },
  greeting: { color: '#e4efff', fontSize: 12 },
  greetingName: { color: '#fff', fontSize: 15, fontWeight: '700', marginTop: 2 },
  greetingRole: { color: '#c5ddfa', fontSize: 10, marginTop: 2 },
  notificationButton: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  notificationGlyph: { color: '#fff', fontSize: 21 },
  notificationDot: { position: 'absolute', top: 8, right: 7, width: 7, height: 7, backgroundColor: '#ffd36e', borderRadius: 4 },
  clockHero: {
    marginTop: 18,
    borderRadius: 16,
    paddingTop: 18,
    paddingBottom: 16,
    alignItems: 'center',
    overflow: 'hidden',
    backgroundColor: '#006744e8',
  },
  heroDecorCircle: {
    position: 'absolute',
    right: -30,
    top: -95,
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#ffffff20',
  },
  heroDate: { color: '#ebf8ef', fontSize: 12 },
  heroTime: { color: '#fff', fontWeight: '800', fontSize: 26, marginTop: 4 },
  markAttendanceButton: {
    marginTop: 12,
    width: '76%',
    height: 42,
    borderRadius: 10,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  markAttendanceDisabled: { opacity: 0.82 },
  markAttendanceText: { color: '#134a36', fontSize: 13, fontWeight: '700' },
  registerPrompt: { paddingTop: 9 },
  registerPromptText: { color: '#d8f4e3', fontSize: 11, fontWeight: '600' },
  homeBody: {
    backgroundColor: '#f5f8fb',
    marginTop: -7,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 15,
    paddingTop: 18,
  },
  shiftSummary: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 15,
    shadowColor: '#2d4960',
    shadowOpacity: 0.07,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  shiftSummaryTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryEyebrow: { color: '#8492a2', fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },
  summaryStatus: { color: '#1e2b3c', fontSize: 15, fontWeight: '700', marginTop: 4 },
  onDutyBadge: { backgroundColor: '#f0f3f5', borderRadius: 20, paddingHorizontal: 9, paddingVertical: 6 },
  onDutyBadgeActive: { backgroundColor: '#e3f7ed' },
  onDutyBadgeText: { color: GREEN, fontSize: 9, fontWeight: '800' },
  summaryDivider: { height: 1, backgroundColor: '#edf0f3', marginVertical: 13 },
  summaryTimes: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  summaryLabel: { color: '#8793a1', fontSize: 9, fontWeight: '700' },
  summaryTime: { color: '#172538', fontSize: 15, fontWeight: '700', marginTop: 4 },
  summaryRight: { alignItems: 'flex-end' },
  summaryClock: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  summaryHours: { color: GREEN, fontSize: 22, fontWeight: '800' },
  summaryUnit: { color: '#738194', fontSize: 9, fontWeight: '700' },
  quickTitle: { color: '#172538', fontSize: 16, fontWeight: '700' },
  dashboardGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 12 },
  dashboardTile: {
    width: '48.5%',
    minHeight: 73,
    backgroundColor: PALE_BLUE,
    borderRadius: 12,
    marginBottom: 9,
    padding: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  tileIcon: { width: 34, height: 34, borderRadius: 9, backgroundColor: '#d9eaff', alignItems: 'center', justifyContent: 'center' },
  tileIconText: { color: BLUE, fontSize: 18, fontWeight: '700' },
  tileTitle: { color: '#1c2b3e', fontSize: 12, fontWeight: '700' },
  tileSubtitle: { color: '#6f7e90', fontSize: 10, marginTop: 3 },
  recentHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 9, marginBottom: 9 },
  viewAll: { color: BLUE, fontSize: 11, fontWeight: '600' },
  emptyActivity: { backgroundColor: '#fff', padding: 15, borderRadius: 12 },
  emptyActivityText: { color: '#8591a0', fontSize: 12 },
  activityRow: { backgroundColor: '#fff', borderRadius: 11, marginBottom: 7, padding: 11, flexDirection: 'row', alignItems: 'center' },
  activityIcon: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  iconGreen: { backgroundColor: '#e2f6eb' },
  iconRed: { backgroundColor: '#ffeded' },
  activityIconText: { color: GREEN, fontWeight: '800', fontSize: 17 },
  activityInfo: { flex: 1, marginLeft: 10 },
  activityName: { color: '#19283b', fontSize: 12, fontWeight: '700' },
  activityDate: { color: '#8692a0', fontSize: 10, marginTop: 3 },
  activityTime: { color: '#344153', fontSize: 11, fontWeight: '700' },
  bottomNav: {
    height: 63,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e8edf1',
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingBottom: 4,
  },
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  navIcon: { color: '#8792a0', fontSize: 19, lineHeight: 22 },
  navLabel: { color: '#8792a0', fontSize: 9 },
  navActive: { color: GREEN, fontWeight: '800' },
  cameraScreen: { flex: 1, backgroundColor: '#fff' },
  cameraHeader: {
    height: 98,
    paddingTop: 43,
    backgroundColor: '#092738',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center' },
  backGlyph: { color: '#fff', fontSize: 34, lineHeight: 38 },
  cameraHeaderTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  headerSpacer: { width: 40 },
  cameraBody: { flex: 1, alignItems: 'center', paddingHorizontal: 20, paddingTop: 20 },
  attendanceToggle: {
    width: '100%',
    height: 42,
    backgroundColor: '#edf0f3',
    borderRadius: 12,
    flexDirection: 'row',
    padding: 4,
    marginBottom: 10,
  },
  hidden: { display: 'none' },
  toggleChoice: { flex: 1, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  toggleChoiceActive: { backgroundColor: GREEN },
  toggleText: { color: '#8792a0', fontSize: 11, fontWeight: '600' },
  toggleTextActive: { color: '#fff' },
  facePreview: {
    width: '78%',
    maxWidth: 300,
    aspectRatio: 0.82,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#d8e0de',
    borderWidth: 5,
    borderColor: '#8b9492',
    marginTop: 3,
  },
  camera: { width: '100%', height: '100%' },
  faceGuideOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  faceGuide: {
    width: '78%',
    height: '72%',
    borderRadius: 999,
    borderWidth: 2,
    borderColor: TURQUOISE,
    backgroundColor: '#ffffff05',
  },
  faceGuideMatched: { borderWidth: 4, borderColor: '#27d97f' },
  guideCorner: { position: 'absolute', width: 18, height: 18, borderColor: '#fff' },
  guideTopLeft: { top: '21%', left: -1, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 5 },
  guideTopRight: { top: '21%', right: -1, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 5 },
  guideBottomLeft: { bottom: '21%', left: -1, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 5 },
  guideBottomRight: { bottom: '21%', right: -1, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 5 },
  facePrompt: { color: '#172538', fontSize: 13, fontWeight: '600', marginTop: 12, textAlign: 'center' },
  faceSubPrompt: { color: '#8994a2', fontSize: 10, marginTop: 4, textAlign: 'center' },
  tipsRow: { flexDirection: 'row', width: '100%', justifyContent: 'space-around', marginTop: 20 },
  cameraTip: { alignItems: 'center', width: '33%' },
  tipIconCircle: { width: 34, height: 34, backgroundColor: '#e7f6ef', borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  tipIcon: { color: GREEN, fontSize: 17 },
  tipText: { color: '#586677', fontSize: 9, marginTop: 6 },
  registrationProgress: { color: GREEN, fontSize: 12, fontWeight: '700', marginTop: 20 },
  cameraStatus: { color: '#778392', fontSize: 10, textAlign: 'center', marginTop: 13, paddingHorizontal: 14 },
  cameraCancel: { marginTop: 10, paddingVertical: 10, paddingHorizontal: 24 },
  cameraCancelText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  processingScreen: { backgroundColor: '#050b0a' },
  processingBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 },
  processingCamera: {
    position: 'absolute',
    width: '110%',
    height: '110%',
    top: '-5%',
    opacity: 0.35,
  },
  processingDim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#030807a8' },
  processingRing: {
    position: 'absolute',
    width: 156,
    height: 156,
    borderWidth: 3,
    borderColor: TURQUOISE,
    borderRadius: 80,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: TURQUOISE,
    shadowOpacity: 0.65,
    shadowRadius: 12,
  },
  processingFocus: { width: 54, height: 54, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#e4f8f6', borderRadius: 12 },
  processingFace: { color: '#fff', fontSize: 32 },
  processingSpinner: { marginTop: 208 },
  processingTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginTop: 16 },
  processingCopy: { color: '#e3e7e5', fontSize: 12, textAlign: 'center', marginTop: 8 },
  processingBlink: { color: '#a8e8dc', fontSize: 11, marginTop: 16 },
  processingCancel: { position: 'absolute', bottom: 36, borderRadius: 10, backgroundColor: '#ffffff20', paddingHorizontal: 22, paddingVertical: 11 },
  successScreen: { flex: 1, backgroundColor: '#fff' },
  successContent: { flexGrow: 1, alignItems: 'center', paddingTop: 74, paddingHorizontal: 20, paddingBottom: 30 },
  successCheck: { width: 82, height: 82, borderRadius: 41, backgroundColor: GREEN, alignItems: 'center', justifyContent: 'center' },
  successCheckText: { color: '#fff', fontSize: 46, lineHeight: 54, fontWeight: '400' },
  successTitle: { color: GREEN, fontSize: 20, lineHeight: 25, fontWeight: '800', textAlign: 'center', marginTop: 7 },
  successProfile: { flexDirection: 'row', alignItems: 'center', width: '100%', backgroundColor: '#f5f8fa', borderRadius: 13, padding: 12, marginTop: 29, marginBottom: 16 },
  successProfileText: { marginLeft: 12 },
  successName: { color: '#1e2939', fontSize: 13, fontWeight: '700' },
  successMeta: { color: '#657286', fontSize: 10, marginTop: 4 },
  detailRow: { width: '100%', minHeight: 45, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#edf0f2' },
  detailIcon: { width: 28, color: '#526174', fontSize: 17 },
  detailLabel: { color: '#344154', fontSize: 11, flex: 1 },
  detailValue: { color: '#172538', fontSize: 11, fontWeight: '700', textAlign: 'right', maxWidth: '54%' },
  successButton: { height: 48, width: '100%', borderRadius: 10, backgroundColor: GREEN, alignItems: 'center', justifyContent: 'center', marginTop: 'auto' },
  successButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  simpleHeader: { height: 93, paddingTop: 42, paddingHorizontal: 15, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#edf0f3' },
  simpleBack: { width: 40, justifyContent: 'center' },
  backDark: { color: '#172538', fontSize: 32, lineHeight: 37 },
  simpleTitle: { color: '#182638', fontSize: 14, fontWeight: '700' },
  headerIcon: { width: 40, alignItems: 'flex-end', justifyContent: 'center' },
  headerIconText: { color: '#435065', fontSize: 23 },
  historyContent: { paddingHorizontal: 15, paddingTop: 14, paddingBottom: 25 },
  monthPicker: { height: 45, borderRadius: 10, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
  monthArrow: { color: '#526174', fontSize: 25 },
  monthTitle: { color: '#172538', fontSize: 12, fontWeight: '700' },
  historyStats: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, gap: 8 },
  statCard: { flex: 1, height: 70, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  statgreen: { backgroundColor: '#e9f7ef' },
  statred: { backgroundColor: '#fff0f0' },
  statblue: { backgroundColor: '#edf4ff' },
  statLabel: { color: '#526174', fontSize: 10 },
  statValue: { fontSize: 19, fontWeight: '800', marginTop: 3 },
  statValuegreen: { color: GREEN },
  statValuered: { color: '#df4343' },
  statValueblue: { color: '#246bd3' },
  historyList: { backgroundColor: '#fff', borderRadius: 12, marginTop: 13, paddingHorizontal: 12 },
  historyRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#edf0f3' },
  historyDate: { flex: 1 },
  historyDateText: { color: '#405065', fontSize: 10 },
  historyTime: { color: '#536276', width: 68, fontSize: 10 },
  historyAction: { borderRadius: 15, overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 5, fontSize: 9, fontWeight: '700' },
  historyIn: { color: GREEN, backgroundColor: '#e3f7ed' },
  historyOut: { color: '#d63e3e', backgroundColor: '#ffeded' },
  emptyHistory: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 15 },
  emptyHistoryIcon: { color: '#9aabb7', fontSize: 32 },
  emptyHistoryTitle: { color: '#26364a', fontSize: 13, fontWeight: '700', marginTop: 9 },
  emptyHistoryCopy: { color: '#8290a0', fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 5 },
  refreshLink: { alignItems: 'center', padding: 15 },
  refreshLinkText: { color: BLUE, fontSize: 11, fontWeight: '600' },
  profileContent: { padding: 14, paddingBottom: 24 },
  profileCard: { backgroundColor: '#fff', borderRadius: 13, padding: 12, flexDirection: 'row', alignItems: 'center', marginBottom: 13 },
  profileCardText: { flex: 1, marginLeft: 12 },
  profileName: { color: '#172538', fontSize: 13, fontWeight: '700' },
  profileMeta: { color: '#708094', fontSize: 10, marginTop: 4 },
  editProfileButton: { alignSelf: 'flex-start', backgroundColor: GREEN, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7, marginTop: 8 },
  editProfileText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  profileRows: { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 12 },
  profileRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#edf0f3' },
  profileRowIcon: { color: '#526174', width: 27, fontSize: 16 },
  profileRowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  profileRowTitle: { color: '#29374a', fontSize: 11 },
  profileRowSubtitle: { color: '#8793a1', fontSize: 9, marginRight: 7 },
  profileChevron: { color: '#9ba6b3', fontSize: 22 },
  destructiveText: { color: '#e24646' },
  registrationCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 13, gap: 10 },
  sectionTitle: { color: '#1c2a3c', fontSize: 14, fontWeight: '700' },
  helpText: { color: '#738092', fontSize: 11, lineHeight: 17 },
  profileInput: { minHeight: 43, borderWidth: 1, borderColor: '#dce3e9', borderRadius: 9, color: '#263449', paddingHorizontal: 11, fontSize: 12, flex: 1 },
  primaryButton: { minHeight: 45, borderRadius: 9, backgroundColor: GREEN, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  linkButton: { alignItems: 'center', padding: 14 },
  linkButtonText: { color: GREEN, fontSize: 11, fontWeight: '700' },
  settingsRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  connectButton: { minHeight: 43, borderRadius: 9, backgroundColor: GREEN, paddingHorizontal: 13, justifyContent: 'center' },
  connectText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  apiStatus: { color: '#738092', fontSize: 10, lineHeight: 15 },
  demoFootnote: { color: '#8995a2', fontSize: 9, textAlign: 'center', marginTop: 16, lineHeight: 14 },
});
