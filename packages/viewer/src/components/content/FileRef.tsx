// FileRef (design 5.3): a path as a link. Click selects, Cmd/Ctrl-click or `o` opens the editor, `c` copies.
import type * as C from '@glimpse/catalog';
import type {GlView} from '../../kit/index.ts';
import {FileLink} from './shared/FileLink.tsx';
import {textOf} from './shared/inline.tsx';
import styles from './FileRef.module.css';

export const FileRefView: GlView<typeof C.FileRef> = ({id, props}) => {
  const file = textOf(props.file).trim();
  if (file === '') return null;
  const label = textOf(props.label).trim();
  return (
    <div className={styles.ref}>
      <FileLink file={file} label={label || undefined} componentId={id} />
    </div>
  );
};
