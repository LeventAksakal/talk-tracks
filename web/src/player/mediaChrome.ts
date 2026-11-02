// Media Chrome (decision 0031): its controller, control bar, buttons, time range and menus, registered on import.
// We skin it (player.css), we do not fork it. JSX types for its tags and ours are declared here: React sets a prop
// as a property when the element has one, else as an attribute.

import type { DetailedHTMLProps, HTMLAttributes } from "react";
import "./domShims";
import "media-chrome";
import "media-chrome/menu";
import { MediaUIEvents } from "media-chrome/constants";
import "./roomMediaElement";

export { MediaUIEvents };

type Tag = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  [attribute: string]: unknown;
};

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- React's JSX types are a namespace
  namespace JSX {
    interface IntrinsicElements {
      "media-controller": Tag;
      "media-control-bar": Tag;
      "media-play-button": Tag;
      "media-seek-backward-button": Tag;
      "media-seek-forward-button": Tag;
      "media-mute-button": Tag;
      "media-volume-range": Tag;
      "media-time-display": Tag;
      "media-time-range": Tag;
      "media-preview-time-display": Tag;
      "media-preview-chapter-display": Tag;
      "media-loading-indicator": Tag;
      "media-pip-button": Tag;
      "media-fullscreen-button": Tag;
      "media-settings-menu": Tag;
      "media-settings-menu-item": Tag;
      "media-settings-menu-button": Tag;
      "media-playback-rate-menu": Tag;
      "media-rendition-menu": Tag;
      "media-chrome-menu": Tag;
      "media-chrome-menu-item": Tag;
      "media-tooltip": Tag;
      "tt-room-media": Tag;
    }
  }
}
