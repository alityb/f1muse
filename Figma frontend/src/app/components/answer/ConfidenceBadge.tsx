import { memo } from 'react';
import type { ConfidenceLevel } from '@/api/types';

interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
  summary?: string;
}

const LEVEL_CONFIG: Record<string, { bg: string; text: string; label: string }> = {
  high: { bg: 'bg-emerald-950/50', text: 'text-emerald-400', label: 'High confidence' },
  medium: { bg: 'bg-amber-950/50', text: 'text-amber-400', label: 'Medium confidence' },
  low: { bg: 'bg-orange-950/50', text: 'text-orange-400', label: 'Low confidence' },
  none: { bg: 'bg-red-950/50', text: 'text-red-400', label: 'Insufficient data' },
  insufficient: { bg: 'bg-red-950/50', text: 'text-red-400', label: 'Limited data' },
};

const DEFAULT_CONFIG = { bg: 'bg-neutral-900', text: 'text-neutral-400', label: 'Unknown' };

export const ConfidenceBadge = memo(function ConfidenceBadge({
  level,
  summary,
}: ConfidenceBadgeProps) {
  const config = LEVEL_CONFIG[level] || DEFAULT_CONFIG;

  return (
    <div
      className={`
        inline-flex items-center gap-2
        px-2.5 py-1.5 rounded
        text-xs
        ${config.bg}
      `}
    >
      <span className={`${config.text} font-medium`}>{config.label}</span>
      {summary && (
        <>
          <span className="text-neutral-600">·</span>
          <span className="text-neutral-500">{summary}</span>
        </>
      )}
    </div>
  );
});
