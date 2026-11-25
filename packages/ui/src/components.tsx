import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useT } from './i18n/index.tsx';

export function Dialog(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [props.onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <header>{props.title}</header>
        <div className="body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  );
}

const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([]);
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((i) => (
          <div className="toast" key={i.id}>
            {i.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Field(props: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="f">
      {props.label}
      {props.children}
      {props.hint && <span className="muted small">{props.hint}</span>}
    </label>
  );
}

export function PasswordInput(props: {
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
  id?: string;
}) {
  const t = useT();
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={props.id}
        className="input"
        type={show ? 'text' : 'password'}
        value={props.value}
        autoFocus={props.autoFocus}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ paddingRight: 44 }}
      />
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? t('hidePassword') : t('showPassword')}
        title={show ? t('hidePassword') : t('showPassword')}
        style={{ position: 'absolute', right: 4, top: 4 }}
      >
        {show ? '🙈' : '👁'}
      </button>
    </div>
  );
}

export function Seg<T extends string>(props: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === props.value ? 'on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
