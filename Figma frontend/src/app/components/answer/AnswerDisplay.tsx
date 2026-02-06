import { memo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { NlQueryResponse } from '@/api/types';
import { ConfidenceBadge } from './ConfidenceBadge';
import { ExpandableDetails } from './ExpandableDetails';
import { TrustSignals } from './TrustSignals';
import { extractPrimaryStat } from './query-renderers';

interface AnswerDisplayProps {
  data: NlQueryResponse;
  question: string | null;
  isLoading?: boolean;
}

export const AnswerDisplay = memo(function AnswerDisplay({
  data,
  question,
  isLoading = false,
}: AnswerDisplayProps) {
  const [showDetails, setShowDetails] = useState(false);

  const { answer, result, query_kind } = data;
  const payload = result?.result?.payload;
  const interpretation = result?.interpretation;

  // Extract primary stat using the query renderer registry
  const primaryStat = extractPrimaryStat(payload, query_kind);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: isLoading ? 0.5 : 1, y: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="py-4"
    >
      {/* Question echo - muted, compact */}
      {question && (
        <p className="text-sm text-neutral-500 mb-5 leading-tight">
          {question}
        </p>
      )}

      {/* Primary stat - the ONE number that matters */}
      {primaryStat && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.12, delay: 0.05 }}
          className="mb-3"
        >
          <span
            className="text-white font-extrabold leading-none tracking-tighter block"
            style={{ fontSize: 'clamp(44px, 12vw, 64px)' }}
          >
            {primaryStat}
          </span>
        </motion.div>
      )}

      {/* Headline - the key insight */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12, delay: 0.08 }}
        className="text-lg text-white font-medium leading-snug tracking-tight"
      >
        {answer.headline}
      </motion.p>

      {/* Supporting bullets - kept minimal */}
      {answer.bullets.length > 0 && (
        <motion.ul
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.12, delay: 0.12 }}
          className="mt-3 space-y-1"
        >
          {answer.bullets.slice(0, 3).map((bullet, i) => (
            <li key={i} className="text-sm text-neutral-400 leading-relaxed">
              {bullet}
            </li>
          ))}
        </motion.ul>
      )}

      {/* Confidence - subtle indicator */}
      {answer.coverage && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.12, delay: 0.15 }}
          className="mt-5"
        >
          <ConfidenceBadge
            level={answer.coverage.level}
            summary={answer.coverage.summary}
          />
        </motion.div>
      )}

      {/* Trust Signals - always visible data context */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12, delay: 0.17 }}
        className="mt-4"
      >
        <TrustSignals
          season={payload?.season as number | string | null | undefined}
          normalization={payload?.normalization as string | null | undefined}
          queryKind={query_kind}
        />
      </motion.div>

      {/* Expandable details - methodology hidden by default */}
      {payload && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.12, delay: 0.18 }}
          className="mt-8"
        >
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="
              w-full text-left px-0 py-3
              border-t border-neutral-800
              hover:border-neutral-700
              transition-colors duration-100
              flex items-center justify-between
              text-xs text-neutral-500 font-medium
              active:bg-neutral-900/50
            "
          >
            <span>{showDetails ? 'Hide' : 'Show'} details & methodology</span>
            <motion.span
              animate={{ rotate: showDetails ? 180 : 0 }}
              transition={{ duration: 0.15 }}
              className="text-sm"
            >
              ↓
            </motion.span>
          </button>

          <AnimatePresence mode="wait">
            {showDetails && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <ExpandableDetails
                  result={payload}
                  interpretation={interpretation}
                  queryKind={query_kind}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </motion.div>
  );
});
