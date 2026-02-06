'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface UnsupportedQueryDisplayProps {
  queryKind: string | null;
  data: unknown;
}

/**
 * Fallback display for query types that are supported by the API
 * but don't have full frontend UI visualization yet.
 */
export function UnsupportedQueryDisplay({ queryKind, data }: UnsupportedQueryDisplayProps) {
  const [showRawJson, setShowRawJson] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl bg-neutral-900/70 border border-neutral-800 p-6"
    >
      {/* Message */}
      <div className="mb-4">
        <p className="text-neutral-300 text-sm mb-2">
          This query is supported by the API but not yet visualized in the frontend.
        </p>
        <p className="text-neutral-500 text-xs">
          Query type: <code className="px-1.5 py-0.5 bg-neutral-800 rounded text-neutral-400">{queryKind || 'unknown'}</code>
        </p>
      </div>

      {/* Toggle button */}
      <button
        onClick={() => setShowRawJson(!showRawJson)}
        className="text-xs text-neutral-400 hover:text-neutral-300 transition-colors flex items-center gap-1.5"
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: showRawJson ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          ▶
        </span>
        {showRawJson ? 'Hide' : 'Show'} raw response
      </button>

      {/* Collapsible JSON panel */}
      <AnimatePresence>
        {showRawJson && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <pre className="mt-3 p-4 bg-neutral-950 rounded-lg text-xs text-neutral-400 overflow-x-auto max-h-96 overflow-y-auto">
              {JSON.stringify(data, null, 2)}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
