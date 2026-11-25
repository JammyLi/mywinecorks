/** Camera QR scanning: the browser's BarcodeDetector when available, else jsQR (ported from MyWines). */
import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Link } from 'react-router-dom';
import { useI18n } from '@mwc/ui';

function beep() {
  try {
    const W = window as unknown as {
      AudioContext: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const a = new (W.AudioContext || W.webkitAudioContext!)();
    const o = a.createOscillator();
    const g = a.createGain();
    o.frequency.value = 1200;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(a.destination);
    o.start();
    setTimeout(() => {
      o.stop();
      void a.close();
    }, 90);
  } catch {
    /* no audio */
  }
  navigator.vibrate?.(60);
}

interface Detector {
  detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}

export function Scanner({ onCode, paused = false }: { onCode: (code: string) => void; paused?: boolean }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef({ code: '', at: 0 });
  const [err, setErr] = useState<'https' | 'denied' | 'nocam' | ''>('');
  const [on, setOn] = useState(false);
  const cb = useRef(onCode);
  cb.current = onCode;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setErr('https');
      return;
    }
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let stop = false;
    let detector: Detector | null = null;
    const BD = (window as unknown as { BarcodeDetector?: new (o: object) => Detector }).BarcodeDetector;
    if (BD) {
      try {
        detector = new BD({ formats: ['qr_code'] });
      } catch {
        detector = null;
      }
    }
    const hit = (code: string) => {
      const now = Date.now();
      if (code === last.current.code && now - last.current.at < 2500) return;
      last.current = { code, at: now };
      beep();
      cb.current(code.trim());
    };
    const loop = async () => {
      if (stop) return;
      const v = video.current;
      if (v && v.readyState >= 2 && !pausedRef.current) {
        try {
          if (detector) {
            const r = await detector.detect(v);
            if (r[0]?.rawValue) hit(r[0].rawValue);
          } else if (canvas.current) {
            const c = canvas.current;
            const w = 480;
            const h = Math.round((v.videoHeight / v.videoWidth) * 480) || 360;
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const r = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
            if (r?.data) hit(r.data);
          }
        } catch {
          /* one bad frame does not matter */
        }
      }
      timer = setTimeout(loop, 180);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        stream = s;
        if (stop) return s.getTracks().forEach((x) => x.stop());
        video.current!.srcObject = s;
        video.current!.play().catch(() => {});
        setOn(true);
        void loop();
      })
      .catch((e: Error) => setErr(e.name === 'NotAllowedError' ? 'denied' : 'nocam'));
    return () => {
      stop = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((x) => x.stop());
    };
  }, []);

  if (err)
    return (
      <div className="scanbox msg">
        {t(`m.cam.${err}`)}
        {err === 'https' && <Link to="/phone">{t('m.phoneSetup')} ›</Link>}
      </div>
    );
  return (
    <div className="scanbox">
      <video ref={video} playsInline muted />
      <canvas ref={canvas} hidden />
      <div className="aim" />
      {!on && <div className="msg">{t('m.cam.starting')}</div>}
    </div>
  );
}
