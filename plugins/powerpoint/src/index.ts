import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { getCurrentUrl, OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, isPowerPointTab, isSharePoint, readReloadMarker, waitForAuth } from './powerpoint-api.js';
import { reportReloadMarker } from './reload-marker.js';
import { addImage } from './tools/add-image.js';
import { addParagraph } from './tools/add-paragraph.js';
import { addShape } from './tools/add-shape.js';
import { addSlide } from './tools/add-slide.js';
import { addSlideLive } from './tools/add-slide-live.js';
import { addTable } from './tools/add-table.js';
import { addTextBox } from './tools/add-text-box.js';
import { alignText } from './tools/align-text.js';
import { commitPresentationTool } from './tools/commit-presentation.js';
import { copyItem } from './tools/copy-item.js';
import { createFolder } from './tools/create-folder.js';
import { createPresentation } from './tools/create-presentation.js';
import { createSharingLink } from './tools/create-sharing-link.js';
import { deleteItem } from './tools/delete-item.js';
import { deletePermission } from './tools/delete-permission.js';
import { deleteShape } from './tools/delete-shape.js';
import { deleteSlide } from './tools/delete-slide.js';
import { deleteSlideLive } from './tools/delete-slide-live.js';
import { diagnose } from './tools/diagnose.js';
import { discardPresentationTool } from './tools/discard-presentation.js';
import { duplicateShape } from './tools/duplicate-shape.js';
import { duplicateSlide as duplicateSlideTool } from './tools/duplicate-slide.js';
import { fitText } from './tools/fit-text.js';
import { formatText } from './tools/format-text.js';
import { getComments } from './tools/get-comments.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { getDownloadUrl } from './tools/get-download-url.js';
import { getDrive } from './tools/get-drive.js';
import { getItem } from './tools/get-item.js';
import { getLiveOutline } from './tools/get-live-outline.js';
import { getPreviewUrl } from './tools/get-preview-url.js';
import { getSlideContent } from './tools/get-slide-content.js';
import { getSlideLayout } from './tools/get-slide-layout.js';
import { getSlideNotes } from './tools/get-slide-notes.js';
import { getSlideStructure } from './tools/get-slide-structure.js';
import { getSlides } from './tools/get-slides.js';
import { getThumbnails } from './tools/get-thumbnails.js';
import { listChildren } from './tools/list-children.js';
import { listPermissions } from './tools/list-permissions.js';
import { listPresentationSessionsTool } from './tools/list-presentation-sessions.js';
import { listRecent } from './tools/list-recent.js';
import { listSharedWithMe } from './tools/list-shared-with-me.js';
import { listSlideLayouts } from './tools/list-slide-layouts.js';
import { listVersions } from './tools/list-versions.js';
import { moveItem } from './tools/move-item.js';
import { moveSlide } from './tools/move-slide.js';
import { moveSlideLive } from './tools/move-slide-live.js';
import { openInEditor } from './tools/open-in-editor.js';
import { openPresentationTool } from './tools/open-presentation.js';
import { reauthenticate } from './tools/reauthenticate.js';
import { renameItem } from './tools/rename-item.js';
import { searchFiles } from './tools/search-files.js';
import { setFontSize } from './tools/set-font-size.js';
import { setHyperlink } from './tools/set-hyperlink.js';
import { setPlaceholderText } from './tools/set-placeholder-text.js';
import { setSlideBackground } from './tools/set-slide-background.js';
import { setSlideHiddenTool } from './tools/set-slide-hidden.js';
import { setText } from './tools/set-text.js';
import { updateShape } from './tools/update-shape.js';
import { updateSlideNotes } from './tools/update-slide-notes.js';

class PowerPointPlugin extends OpenTabsPlugin {
  readonly name = 'powerpoint';
  readonly description = 'OpenTabs plugin for Microsoft PowerPoint Online';
  override readonly displayName = 'PowerPoint Online';
  readonly urlPatterns = ['*://powerpoint.cloud.microsoft/*', '*://*.sharepoint.com/:p:/*'];
  override readonly homepage = 'https://powerpoint.cloud.microsoft';
  readonly tools: ToolDefinition[] = [
    // Account
    getCurrentUser,
    reauthenticate,
    diagnose,
    getDrive,
    // Files
    listChildren,
    listRecent,
    searchFiles,
    listSharedWithMe,
    getItem,
    getDownloadUrl,
    getThumbnails,
    renameItem,
    deleteItem,
    copyItem,
    moveItem,
    createFolder,
    // Presentations
    createPresentation,
    getPreviewUrl,
    openInEditor,
    // Sessions (batched edits)
    openPresentationTool,
    commitPresentationTool,
    discardPresentationTool,
    listPresentationSessionsTool,
    // Slides — structure first, since naming a slot is the usual way in
    getSlideStructure,
    setPlaceholderText,
    getLiveOutline,
    setText,
    setFontSize,
    formatText,
    alignText,
    setHyperlink,
    addSlideLive,
    addParagraph,
    deleteSlideLive,
    moveSlideLive,
    setSlideBackground,
    listSlideLayouts,
    addSlide,
    deleteSlide,
    duplicateSlideTool,
    moveSlide,
    setSlideHiddenTool,
    getSlides,
    getSlideContent,
    getSlideLayout,
    addTextBox,
    addShape,
    addImage,
    addTable,
    updateShape,
    fitText,
    deleteShape,
    duplicateShape,
    getSlideNotes,
    updateSlideNotes,
    getComments,
    // Sharing
    listPermissions,
    createSharingLink,
    deletePermission,
    // Versions
    listVersions,
  ];

  /**
   * Records an Office-initiated document reload in the plugin log, once per
   * document, so a tool failure can be correlated with the reload that
   * preceded it.
   */
  override onActivate(): void {
    const marker = readReloadMarker();
    if (marker) reportReloadMarker(marker, new URL(getCurrentUrl()).origin);
  }

  async isReady(): Promise<boolean> {
    if (!isPowerPointTab()) return false;
    if (isAuthenticated()) return true;
    // On SharePoint/OneDrive-hosted presentations the Graph token is captured
    // asynchronously by the pre-script and may not have arrived yet. Report the
    // presentation page as ready so the plugin activates on load; tool handlers
    // surface a clear auth error if the token has not been captured.
    if (isSharePoint()) return true;
    return waitForAuth();
  }
}

export default new PowerPointPlugin();
