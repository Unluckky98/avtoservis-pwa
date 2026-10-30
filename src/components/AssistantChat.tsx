import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Banner } from '@astryxdesign/core/Banner';
import { Spinner } from '@astryxdesign/core/Spinner';
import { PaperPlaneRight } from '@phosphor-icons/react';
import { askAssistant, type Turn } from '../lib/assistant';

export function AssistantChat({ client, slug, mode, hints }: { client: () => SupabaseClient; slug: string; mode: 'client' | 'owner'; hints: string[] }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [turns, busy]);

  async function send(q: string, base: Turn[] = turns) {
    const content = q.trim();
    if (!content || busy) return;
    const next: Turn[] = [...base, { role: 'user', content: content.slice(0, 1000) }];
    setTurns(next);
    setText('');
    setError(null);
    setBusy(true);
    try {
      const answer = await askAssistant(client(), slug, mode, next);
      setTurns([...next, { role: 'assistant', content: answer }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Помощник недоступен.');
    } finally {
      setBusy(false);
    }
  }

  const lastUser = [...turns].reverse().find((t) => t.role === 'user');

  return (
    <VStack gap={3}>
      {turns.length === 0 && (
        <VStack gap={2}>
          <Text type="supporting">{mode === 'client' ? 'Спросите про услуги, цены и свободное время. Записаться можно кнопкой «Записаться».' : 'Спросите про записи и показатели. Помощник только читает данные и ничего не меняет.'}</Text>
          <HStack gap={2} wrap="wrap">
            {hints.map((h) => (
              <button key={h} type="button" className="pill" onClick={() => void send(h)}>
                {h}
              </button>
            ))}
          </HStack>
        </VStack>
      )}
      <VStack gap={2} as="ol" className="m-0 p-0 list-none" aria-live="polite">
        {turns.map((t, i) => (
          <li key={i} className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-3 ${t.role === 'user' ? 'self-end chip-on' : 'self-start card-glass !rounded-2xl'}`}>
            <span className="sr-only">{t.role === 'user' ? 'Вы: ' : 'Помощник: '}</span>
            {t.content}
          </li>
        ))}
      </VStack>
      {busy && <Spinner size="md" label="Помощник думает…" />}
      {error && (
        <Banner
          status="warning"
          title="Не получилось получить ответ"
          description={error}
          collapsible={false}
          endContent={lastUser ? <Button label="Повторить" size="sm" variant="secondary" onClick={() => void send(lastUser.content, turns.slice(0, turns.lastIndexOf(lastUser)))} /> : undefined}
        />
      )}
      <form noValidate onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <HStack gap={2} vAlign="end">
          <TextInput label="Вопрос" isLabelHidden placeholder="Напишите вопрос…" value={text} onChange={setText} width="100%" />
          <button type="submit" className="send-btn" aria-label="Отправить" disabled={!text.trim() || busy}>
            <PaperPlaneRight size={22} weight="fill" aria-hidden="true" />
          </button>
        </HStack>
      </form>
      <div ref={end} />
    </VStack>
  );
}
