import { useNavigate, useParams } from 'react-router-dom';
import { chaptersFrom, ManualView } from '@mwc/ui';
import { useHqT } from '../i18n.ts';

const files = {
  en: import.meta.glob('../help/en/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >,
  'zh-TW': import.meta.glob('../help/zh/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >,
};
export const HQ_MANUAL = { en: chaptersFrom(files.en), 'zh-TW': chaptersFrom(files['zh-TW']) };

/** The HQ staff manual (internal: only signed-in staff see it). */
export function Help() {
  const { t, lang } = useHqT();
  const { slug } = useParams();
  const nav = useNavigate();
  return (
    <div className="page">
      <ManualView
        chapters={HQ_MANUAL[lang]}
        current={slug}
        onOpen={(s) => nav(`/help/${s}`)}
        labels={{ contents: t('hq.help.contents'), prev: t('hq.help.prev'), next: t('hq.help.next') }}
      />
    </div>
  );
}
