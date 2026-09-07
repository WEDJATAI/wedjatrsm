'use client'

// ─── i18n core: language context, RTL, dictionary registry ──────────
// Dictionary files: dict/common.ts (shared, owner: main), dict/auth.ts
// (owner: 6-d), dict/pos.ts + dict/kitchen.ts (owner: 6-c),
// dict/admin.ts (owner: 6-e). Keys are flat with dot namespaces, e.g.
// 'common.save', 'pos.sendToKitchen'. Arabic uses MSA with Egyptian
// restaurant terminology; numbers stay Latin digits (format helpers).
//
// The language is persisted in localStorage and read through
// useSyncExternalStore (SSR-safe: server snapshot is always 'en', the
// client re-renders with the stored preference right after hydration).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import { common } from './dict/common'
import { authDict } from './dict/auth'
import { posDict } from './dict/pos'
import { kitchenDict } from './dict/kitchen'
import { adminDict } from './dict/admin'
import { setFormatLocale, type FormatLang } from '@/lib/format'

export type Lang = 'en' | 'ar'

const LANG_STORAGE_KEY = 'rms_lang'
const LANG_EVENT = 'rms-lang-change'

export type Dict = Record<string, string>
export type DictPair = { en: Dict; ar: Dict }

const DICT_PAIRS: DictPair[] = [common, authDict, posDict, kitchenDict, adminDict]

const FULL_DICT: Record<Lang, Dict> = { en: {}, ar: {} }
for (const pair of DICT_PAIRS) {
  Object.assign(FULL_DICT.en, pair.en)
  Object.assign(FULL_DICT.ar, pair.ar)
}

export type I18nContextValue = {
  lang: Lang
  isRTL: boolean
  /** set the language (persists to localStorage) */
  setLang: (lang: Lang) => void
  /** toggle between the two languages */
  toggleLang: () => void
  /** translate a key; supports {var} interpolation; falls back to English then the key tail */
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

// ── localStorage-backed language store (useSyncExternalStore) ────────

function subscribe(onChange: () => void): () => void {
  window.addEventListener(LANG_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(LANG_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

function getSnapshot(): Lang {
  try {
    return window.localStorage.getItem(LANG_STORAGE_KEY) === 'ar' ? 'ar' : 'en'
  } catch {
    return 'en'
  }
}

function getServerSnapshot(): Lang {
  return 'en'
}

function emitLangChange() {
  window.dispatchEvent(new Event(LANG_EVENT))
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // apply document direction + formatting locale on every change (DOM sync only)
  useEffect(() => {
    const doc = document.documentElement
    doc.lang = lang
    doc.dir = lang === 'ar' ? 'rtl' : 'ltr'
    setFormatLocale(lang as FormatLang)
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next)
    } catch {
      // storage unavailable — preference lasts for the session only
    }
    emitLangChange()
  }, [])

  const toggleLang = useCallback(() => {
    const next: Lang = getSnapshot() === 'en' ? 'ar' : 'en'
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next)
    } catch {
      // ignore
    }
    emitLangChange()
  }, [])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let value = FULL_DICT[lang][key] ?? FULL_DICT.en[key] ?? key.split('.').pop() ?? key
      if (vars) {
        for (const [name, replacement] of Object.entries(vars)) {
          value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), String(replacement))
        }
      }
      return value
    },
    [lang],
  )

  const contextValue = useMemo<I18nContextValue>(
    () => ({ lang, isRTL: lang === 'ar', setLang, toggleLang, t }),
    [lang, setLang, toggleLang, t],
  )

  return <I18nContext.Provider value={contextValue}>{children}</I18nContext.Provider>
}

/** Access the language context (falls back to English outside the provider). */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    // defensive fallback so a stray import never crashes the app
    return {
      lang: 'en',
      isRTL: false,
      setLang: () => undefined,
      toggleLang: () => undefined,
      t: (key) => key.split('.').pop() ?? key,
    }
  }
  return ctx
}
