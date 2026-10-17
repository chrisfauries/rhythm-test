import React from "react";

// Small shared building blocks, styled to match the flash-cards app.

export const Card: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ className, children }) => (
  <div
    className={`w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-3xl shadow-[0_4px_20px_rgb(0,0,0,0.04)] dark:shadow-none border border-slate-100/50 dark:border-slate-800/50 p-4 md:p-6 ${className ?? ""}`}
  >
    {children}
  </div>
);

export const SectionLabel: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ className, children }) => (
  <h3
    className={`text-[11px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 text-center mb-3 ${className ?? ""}`}
  >
    {children}
  </h3>
);

export const Pill: React.FC<
  React.PropsWithChildren<{
    selected?: boolean;
    onClick?: () => void;
    title?: string;
    disabled?: boolean;
    round?: boolean;
    className?: string;
  }>
> = ({ selected, onClick, title, disabled, round, className, children }) => (
  <button
    type="button"
    title={title}
    aria-pressed={selected}
    disabled={disabled}
    onClick={onClick}
    className={`relative flex items-center justify-center gap-2 ${
      round ? "min-w-[2.75rem] h-11 px-2.5 rounded-full text-base" : "px-4 py-2 rounded-full text-sm"
    } font-bold border transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-95 outline-none select-none disabled:opacity-40 disabled:pointer-events-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 ${
      selected
        ? "bg-walsh-green text-white border-emerald-700 shadow-lg shadow-emerald-700/30 scale-105 -translate-y-0.5 z-10"
        : "bg-white text-slate-600 border-slate-200/80 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-800 dark:bg-slate-800/80 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
    } ${className ?? ""}`}
  >
    {children}
  </button>
);

type ButtonVariant = "primary" | "secondary" | "danger" | "gold";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-walsh-green text-white shadow-lg shadow-emerald-800/30 hover:bg-emerald-700 focus-visible:ring-emerald-500",
  gold: "bg-walsh-gold text-amber-950 shadow-lg shadow-amber-500/30 hover:bg-amber-400 focus-visible:ring-amber-400",
  secondary:
    "bg-slate-200 text-slate-800 shadow-sm hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 focus-visible:ring-slate-500",
  danger: "bg-rose-600 text-white shadow-lg shadow-rose-600/30 hover:bg-rose-500 focus-visible:ring-rose-500",
};

export const Button: React.FC<
  React.PropsWithChildren<{
    variant?: ButtonVariant;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
    className?: string;
  }>
> = ({ variant = "primary", onClick, disabled, title, className, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={`flex items-center justify-center gap-2 px-7 py-3.5 rounded-full text-sm md:text-base font-bold transition-all duration-300 ease-out active:scale-95 outline-none hover:scale-105 focus-visible:ring-4 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 disabled:opacity-40 disabled:pointer-events-none ${VARIANTS[variant]} ${className ?? ""}`}
  >
    {children}
  </button>
);

export type StatusTone = "idle" | "busy" | "ok" | "error";

const TONE_DOT: Record<StatusTone, string> = {
  idle: "bg-slate-300 dark:bg-slate-600",
  busy: "bg-amber-400 animate-pulse",
  ok: "bg-emerald-500",
  error: "bg-rose-500",
};

export const StatusPill: React.FC<
  React.PropsWithChildren<{ label: string; tone: StatusTone; icon: React.ReactNode }>
> = ({ label, tone, icon, children }) => (
  <div className="flex flex-1 min-w-[180px] items-center gap-3 bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border border-slate-100 dark:border-slate-700/50">
    <div className="relative flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-white dark:bg-slate-800 shadow-sm border border-slate-200/50 dark:border-slate-700 text-slate-500 dark:text-slate-300">
      {icon}
      <span className={`absolute -right-0.5 -top-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-slate-800 ${TONE_DOT[tone]}`} />
    </div>
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-0.5">
        {label}
      </span>
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">{children}</span>
    </div>
  </div>
);

export const Modal: React.FC<React.PropsWithChildren<{ title: string; onClose: () => void; wide?: boolean }>> = ({
  title,
  onClose,
  wide,
  children,
}) => (
  <div
    className="fixed inset-0 z-50 flex items-start md:items-center justify-center bg-slate-950/50 backdrop-blur-sm p-4 overflow-y-auto"
    onClick={onClose}
  >
    <div
      className={`w-full ${wide ? "max-w-4xl" : "max-w-xl"} bg-white dark:bg-slate-900 rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 p-6 my-8`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-extrabold tracking-tight">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="w-9 h-9 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 text-xl leading-none"
          aria-label="Close"
        >
          ×
        </button>
      </div>
      {children}
    </div>
  </div>
);

export const Icon = {
  mic: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
    </svg>
  ),
  voice: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
    </svg>
  ),
  camera: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
    </svg>
  ),
  gear: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  chart: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  ),
  target: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  ),
};
