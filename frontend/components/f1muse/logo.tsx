"use client"

interface F1MuseIconProps {
  size?: number
  className?: string
}

/**
 * Standalone icon mark for F1Muse.
 *
 * Concept: Three stacked parallelogram slashes — like speed lines or
 * a racing flag abstraction — arranged vertically with increasing width.
 * The negative space between them creates rhythm and movement.
 * Minimal, abstract, and instantly recognizable at any size.
 */
export function F1MuseIcon({ size = 40, className }: F1MuseIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Top slash — shortest, brightest */}
      <polygon points="26,8 46,8 40,20 20,20" fill="#ffffff" />

      {/* Middle slash — medium, slightly dimmer */}
      <polygon points="18,26 50,26 44,38 12,38" fill="#d1d5db" />

      {/* Bottom slash — widest, darkest */}
      <polygon points="10,44 54,44 48,56 4,56" fill="#9ca3af" />
    </svg>
  )
}

// Backwards compatible alias
export function F1MuseLogo({ size = 28 }: { size?: number }) {
  return <F1MuseIcon size={size} />
}

interface F1MuseWordmarkProps {
  size?: "sm" | "md" | "lg"
  className?: string
  showIcon?: boolean
}

const sizeConfig = {
  sm: { icon: 28, text: "text-base", gap: "gap-2" },
  md: { icon: 36, text: "text-xl", gap: "gap-2.5" },
  lg: { icon: 48, text: "text-3xl", gap: "gap-3" },
}

/**
 * Full F1Muse logo — icon + wordmark.
 *
 * The wordmark uses tight tracking on "F1" with a lighter weight on "Muse"
 * to create visual hierarchy that mirrors the icon's bold/subtle duality.
 */
export function F1MuseWordmark({
  size = "sm",
  className,
  showIcon = true,
}: F1MuseWordmarkProps) {
  const config = sizeConfig[size]

  return (
    <div className={`flex items-center ${config.gap} ${className ?? ""}`}>
      {showIcon && <F1MuseIcon size={config.icon} />}
      <span className={`${config.text} tracking-tight leading-none select-none`}>
        <span className="font-bold text-white">F1</span>
        <span className="font-light text-gray-400">Muse</span>
      </span>
    </div>
  )
}
