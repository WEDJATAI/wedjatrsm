'use client'

/**
 * r48 — shared motion primitives (motion v14, the framer-motion successor).
 *
 * Small, dependency-light building blocks used across the upscaled UI:
 *  - <AnimatedNumber>  spring-counted numeric readouts (dashboards, totals)
 *  - <FadeIn>          one-shot mount fade/slide
 *  - <FadeInStagger>   container that staggers <FadeInItem> children
 *  - <PressableCard>   touch-friendly press feedback wrapper
 *  - <Shimmer>         skeleton block with the .shimmer CSS sweep
 *
 * All components respect prefers-reduced-motion via the global CSS rule
 * in globals.css (animations collapse to ~0ms).
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { motion, useInView, useMotionValue, useSpring } from 'motion/react'

import { cn } from '@/lib/utils'

/** Ease used across the app — a confident "swift out" curve. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const

// ── AnimatedNumber ──────────────────────────────────────────────────

export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number
  /** format the live spring value for display (defaults to round + locale) */
  format?: (v: number) => string
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const motionValue = useMotionValue(0)
  const spring = useSpring(motionValue, { damping: 34, stiffness: 160 })
  const inView = useInView(ref, { once: true, margin: '-24px' })

  useEffect(() => {
    if (inView) motionValue.set(value)
  }, [inView, motionValue, value])

  useEffect(() => {
    const render = (latest: number) => {
      if (ref.current) {
        ref.current.textContent = format
          ? format(latest)
          : Math.round(latest).toLocaleString()
      }
    }
    render(spring.get())
    return spring.on('change', render)
  }, [spring, format])

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      {format ? format(0) : '0'}
    </span>
  )
}

// ── FadeIn / stagger ────────────────────────────────────────────────

export function FadeIn({
  children,
  delay = 0,
  y = 8,
  duration = 0.32,
  className,
}: {
  children: ReactNode
  delay?: number
  y?: number
  duration?: number
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: [...EASE_OUT] }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function FadeInStagger({
  children,
  className,
  delay = 0,
  stagger = 0.05,
}: {
  children: ReactNode
  className?: string
  delay?: number
  stagger?: number
}) {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: stagger, delayChildren: delay } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function FadeInItem({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 8 },
        show: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.28, ease: [...EASE_OUT] },
        },
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

// ── PressableCard ───────────────────────────────────────────────────

export function PressableCard({
  children,
  className,
  onClick,
  disabled,
  ariaLabel,
}: {
  children: ReactNode
  className?: string
  onClick?: () => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <motion.button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 420, damping: 24 }}
      className={cn(disabled && 'pointer-events-none', className)}
    >
      {children}
    </motion.button>
  )
}

// ── Shimmer skeleton ────────────────────────────────────────────────

export function Shimmer({ className }: { className?: string }) {
  return <div className={cn('shimmer rounded-md bg-muted', className)} aria-hidden />
}
