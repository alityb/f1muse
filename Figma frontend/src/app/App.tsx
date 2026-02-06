import { useState, useCallback, useRef } from 'react';
import { useF1Query } from '@/api/useQuery';
import { SearchInput, SearchInputRef } from '@/app/components/SearchInput';
import { SuggestedQueries } from '@/app/components/SuggestedQueries';
import { ResultsView } from '@/app/components/ResultsView';
import { F1MuseWordmark } from '@/app/components/F1MuseWordmark';
import { AnimatePresence, motion } from 'motion/react';

type ViewState = 'landing' | 'active';

export default function App() {
  const [view, setView] = useState<ViewState>('landing');
  const query = useF1Query();
  const searchInputRef = useRef<SearchInputRef>(null);

  const handleFocus = useCallback(() => {
    if (view === 'landing') {
      setView('active');
    }
  }, [view]);

  const handleSearch = useCallback(
    (question: string) => {
      if (!question.trim()) return;
      setView('active');
      query.submit(question);
    },
    [query]
  );

  const handleNewSearch = useCallback(() => {
    query.reset();
    // Focus the search input after reset
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [query]);

  // Handle clicking a suggestion (from error state or suggestions)
  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      // Set the value in the search input and submit
      searchInputRef.current?.setValue(suggestion);
      handleSearch(suggestion);
    },
    [handleSearch]
  );

  const showResults = query.hasResult || query.hasError;
  const showSuggestions = !showResults && !query.isLoading;

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <header className="px-4 md:px-8 pt-5 pb-5 border-b border-neutral-900">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <F1MuseWordmark size="md" theme="dark" />
          <AnimatePresence>
            {showResults && (
              <motion.button
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.12 }}
                onClick={handleNewSearch}
                className="
                  px-4 py-2
                  text-neutral-500 text-sm font-medium
                  border border-neutral-800
                  hover:border-neutral-700 hover:text-white
                  active:bg-neutral-900
                  transition-colors duration-100
                "
              >
                new search
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </header>

      {/* Main content */}
      <main className="px-4 md:px-8">
        <div className="max-w-2xl mx-auto">
          {/* Search bar area - smooth transition */}
          <motion.div
            animate={{
              paddingTop: view === 'landing' ? '25vh' : showResults ? 24 : 48,
            }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <SearchInput
              ref={searchInputRef}
              onFocus={handleFocus}
              onSubmit={handleSearch}
              isLoading={query.isLoading}
              compact={showResults}
            />
          </motion.div>

          {/* Content area - crossfade between states */}
          <div className="relative min-h-[200px]">
            <AnimatePresence mode="wait">
              {query.isLoading && !showResults && (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                  className="mt-8"
                >
                  <LoadingSkeleton />
                </motion.div>
              )}

              {showResults && (
                <motion.div
                  key={`results-${query.activeQuestion}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="mt-6"
                >
                  <ResultsView
                    data={query.data}
                    question={query.activeQuestion}
                    error={query.error}
                    isLoading={query.isLoading}
                    onSuggestionClick={handleSuggestionClick}
                  />
                </motion.div>
              )}

              {showSuggestions && (
                <motion.div
                  key="suggestions"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="mt-8"
                >
                  <SuggestedQueries onSelect={handleSuggestionClick} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Loading skeleton - subtle, not distracting
 */
function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <motion.div
        className="h-4 w-48 bg-neutral-900 rounded"
        animate={{ opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="h-14 w-24 bg-neutral-900 rounded"
        animate={{ opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: 0.1 }}
      />
      <motion.div
        className="h-5 w-72 bg-neutral-900 rounded"
        animate={{ opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
      />
    </div>
  );
}
