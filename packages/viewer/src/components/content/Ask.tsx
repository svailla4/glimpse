// Ask (design 5.3): a decision card. The prompt, set as a question, then one numbered tile per option on a grid that
// fills the card: side by side when there is room, stacked when there is not. After a pick the chosen tile keeps a
// tick in place of its number, the others fade, and "queued for the agent" says where the pick went. A pick dispatches
// `name` (default `answer`) with {choice}. The numbers are drawn by CSS, so an option's text and accessible name are
// the option alone. The options are one tab stop: either pair of arrows, Home and End move, Enter or Space picks.
import type * as C from '@glimpse/catalog';
import {useId, useState} from 'react';
import {Icon, useHostActions, useLinkStatus, type GlView} from '../../kit/index.ts';
import {Inline, textOf} from './shared/inline.tsx';
import {ENDED_TITLE, Queued} from './shared/Queued.tsx';
import {useRoving} from './shared/roving.ts';
import styles from './Ask.module.css';

const EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export const AskView: GlView<typeof C.Ask> = ({id, props}) => {
  const host = useHostActions(id);
  const promptId = useId();
  const options = Array.isArray(props.options) ? [...new Set(props.options.filter(option => typeof option === 'string' && option.trim() !== ''))] : [];
  const [choice, setChoice] = useState<string>();
  // A pick was tried after the session ended.
  const [refused, setRefused] = useState(false);
  // Once the session is over the shell drops whatever a view sends: nothing picked here can reach the agent.
  const ended = useLinkStatus() === 'ended';
  const chosen = choice !== undefined && options.includes(choice) ? choice : undefined;
  // Taken apart: the React Compiler treats an object holding a ref as a ref (decision compiled-viewer).
  const {ref: rovingRef, onKeyDown, item} = useRoving<HTMLDivElement>(options.length, 'both');
  const name = typeof props.name === 'string' && EVENT_NAME.test(props.name) ? props.name : 'answer';
  const prompt = textOf(props.prompt);

  const pick = (option: string) => {
    // A pick made after the session ended goes nowhere: it is not marked as chosen and the card says why.
    if (ended) {
      setRefused(true);
      return;
    }
    setChoice(option);
    host.emit(name, {choice: option});
  };

  return (
    <section className={styles.ask} aria-labelledby={prompt.trim() ? promptId : undefined}>
      {prompt.trim() ? (
        <p className={styles.prompt} id={promptId}>
          <Inline text={prompt} componentId={id} />
        </p>
      ) : null}
      {options.length > 0 ? (
        <div
          className={styles.options}
          role="group"
          data-picked={chosen !== undefined || undefined}
          aria-label="Options" ref={rovingRef} onKeyDown={onKeyDown}>
          {options.map((option, i) => (
            <button
              key={option}
              type="button"
              className={styles.option}
              aria-pressed={option === chosen}
              aria-disabled={ended || undefined}
              title={ended ? ENDED_TITLE : undefined}
              data-chosen={option === chosen || undefined}
              {...item(i)}
              onClick={() => pick(option)}
            >
              <span className={styles.index} aria-hidden="true">
                {option === chosen ? <Icon name="check" /> : null}
              </span>
              <span className={styles.optionLabel}>{option}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.none}>no options to choose from</p>
      )}
      <Queued state={ended && refused ? 'ended' : chosen !== undefined ? 'queued' : 'idle'} detail={chosen} />
    </section>
  );
};
