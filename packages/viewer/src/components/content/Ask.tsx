// Ask (design 5.3): a decision card. The prompt, one outlined button per option, and after a pick the chosen option
// stays marked next to "queued for the agent". A pick dispatches `name` (default `answer`) with {choice}.
// The options are one tab stop: arrows, Home and End move between them, Enter or Space picks.
import type * as C from '@glimpse/catalog';
import {useId, useState} from 'react';
import {Icon, useHostActions, type GlView} from '../../kit/index.ts';
import {Inline, textOf} from './shared/inline.tsx';
import {Queued} from './shared/Queued.tsx';
import {useRoving} from './shared/roving.ts';
import styles from './Ask.module.css';

const EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export const AskView: GlView<typeof C.Ask> = ({id, props}) => {
  const host = useHostActions(id);
  const promptId = useId();
  const options = Array.isArray(props.options) ? [...new Set(props.options.filter(option => typeof option === 'string' && option.trim() !== ''))] : [];
  const [choice, setChoice] = useState<string>();
  const chosen = choice !== undefined && options.includes(choice) ? choice : undefined;
  const roving = useRoving<HTMLDivElement>(options.length, 'horizontal');
  const name = typeof props.name === 'string' && EVENT_NAME.test(props.name) ? props.name : 'answer';
  const prompt = textOf(props.prompt);

  const pick = (option: string) => {
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
        <div className={styles.options} role="group" aria-label="Options" ref={roving.ref} onKeyDown={roving.onKeyDown}>
          {options.map((option, i) => (
            <button
              key={option}
              type="button"
              className={styles.option}
              aria-pressed={option === chosen}
              data-chosen={option === chosen || undefined}
              {...roving.item(i)}
              onClick={() => pick(option)}
            >
              {option === chosen ? <Icon name="check" /> : null}
              <span className={styles.optionLabel}>{option}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.none}>no options to choose from</p>
      )}
      <Queued state={chosen !== undefined ? 'queued' : 'idle'} detail={chosen} />
    </section>
  );
};
