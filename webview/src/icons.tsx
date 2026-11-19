import type { JSX } from 'preact';

type P = { size?: number; class?: string };
const svg = (path: JSX.Element, viewBox = '0 0 16 16') =>
  function Icon({ size = 16, class: cls }: P) {
    return (
      <svg class={`icon ${cls ?? ''}`} width={size} height={size} viewBox={viewBox} fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {path}
      </svg>
    );
  };

export const IconPlus = svg(<path d="M8 3v10M3 8h10" />);
/** Two chain links: carry something from one place into another. */
export const IconLink = svg(
  <>
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
    <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
  </>,
);
export const IconHistory = svg(
  <>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" />
    <path d="M2.5 2.5v2.8h2.8M8 5v3.2l2 1.3" />
  </>,
);
export const IconPlug = svg(
  <>
    <path d="M6 2v3M10 2v3M4 5h8v2.5a4 4 0 0 1-8 0V5Z" />
    <path d="M8 11.5V14" />
  </>,
);
export const IconChart = svg(<path d="M2.5 13.5h11M4.5 11V7.5M8 11V3.5M11.5 11V6" />);
export const IconClip = svg(<path d="M12.5 7.5 8 12a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8l-5 5a1 1 0 0 1-1.4-1.4L9.5 5" />);
export const IconSend = svg(<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />);
export const IconStop = svg(<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />);
export const IconChevron = svg(<path d="m4 6 4 4 4-4" />);
export const IconClose = svg(<path d="m4 4 8 8M12 4l-8 8" />);
export const IconCheck = svg(<path d="m3 8.5 3.2 3L13 4.5" />);
export const IconCopy = svg(
  <>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </>,
);
export const IconShield = svg(<path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4L8 1.8Z" />);
export const IconZap = svg(<path d="M9 1.8 3.5 9H8l-1 5.2L12.5 7H8l1-5.2Z" />);
export const IconUser = svg(
  <>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 13.5a5 5 0 0 1 10 0" />
  </>,
);
export const IconTrash = svg(<path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" />);
export const IconPencil = svg(<path d="m10.5 3 2.5 2.5L6 12.5l-3 .5.5-3L10.5 3Z" />);
export const IconRefresh = svg(
  <>
    <path d="M13.5 8a5.5 5.5 0 0 1-9.6 3.7M2.5 8a5.5 5.5 0 0 1 9.6-3.7" />
    <path d="M12.3 1.8v2.7H9.6M3.7 14.2v-2.7h2.7" />
  </>,
);
export const IconGear = svg(
  <>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
  </>,
);
export const IconKey = svg(
  <>
    <circle cx="5" cy="11" r="2.5" />
    <path d="m7 9 6-6M10.5 5.5l1.5 1.5M12 4l1.5 1.5" />
  </>,
);
export const IconFile = svg(<path d="M4 2.5h5l3 3v8H4v-11ZM9 2.5v3h3" />);
export const IconImage = svg(
  <>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="m3 11 3-3 2.5 2.5L10.5 8l3 3" />
    <circle cx="6" cy="6" r="1" />
  </>,
);
export const IconTool = svg(<path d="M9.5 2.5a3.5 3.5 0 0 0-3.3 4.7L2.5 11v2.5H5l3.8-3.7a3.5 3.5 0 0 0 4.4-4.6L11 7.4 8.6 5l2.2-2.2a3.5 3.5 0 0 0-1.3-.3Z" />);
export const IconBrain = svg(
  <>
    <path d="M8 3.2c-.8-1-2.6-1-3.2.3-1.4.2-2 1.8-1.2 2.9-.9.9-.6 2.6.7 3 .1 1.4 1.7 2.1 2.8 1.3L8 10" />
    <path d="M8 3.2c.8-1 2.6-1 3.2.3 1.4.2 2 1.8 1.2 2.9.9.9.6 2.6-.7 3-.1 1.4-1.7 2.1-2.8 1.3L8 10M8 3.2V13" />
  </>,
);
export const IconInsert = svg(<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />);
export const IconSearch = svg(
  <>
    <circle cx="7" cy="7" r="4" />
    <path d="m10 10 3.5 3.5" />
  </>,
);
export const IconWarn = svg(<path d="M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.3v.2" />);
export const IconEye = svg(
  <>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.8" />
  </>,
);
