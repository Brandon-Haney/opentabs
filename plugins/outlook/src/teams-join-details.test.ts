import { describe, expect, test } from 'vitest';
import { extractTeamsJoinDetails, linksTo } from './teams-join-details.js';

const JOIN_URL = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d';
const SHORT_JOIN = 'https://teams.microsoft.com/meet/111222333?p=abc';

/** The join details as Exchange writes them below an HTML body (abridged). */
const HTML_DETAILS =
  '<div class="me-email-text" lang="en-US" style="max-width:1024px">' +
  '<div aria-hidden="true">________________________________________________________________________________</div>' +
  '<div><span class="me-email-text">Microsoft Teams meeting</span></div>' +
  `<div><span class="me-email-text">Join: </span><a href="${SHORT_JOIN}" id="meet_invite_block.action.join_link" class="me-email-link">${SHORT_JOIN}</a></div>` +
  `<div><a href="${JOIN_URL}" id="meet_invite_block.action.join_link_compatibility">System reference</a></div>` +
  '</div>';

const htmlBody = (description: string) =>
  `<html><head><meta charset="utf-8"></head><body><div style="font-size:12pt">${description}</div><br>${HTML_DETAILS}</body></html>`;

/** A plain-text body as Exchange stores it: converted to HTML, with the join details as lines. */
const textBody = (description: string, separator = false) =>
  '<html><head><meta charset="utf-8"></head><body><font size="2"><span style="font-size:11pt;"><div class="PlainText">' +
  `${description}<br>\r\n` +
  (separator ? '________________________________________________________________________________<br>\r\n' : '') +
  'Microsoft Teams meeting<br>\r\n' +
  `Join: <a href="${SHORT_JOIN}">${SHORT_JOIN}</a><br>\r\n` +
  `System reference: <a href="${JOIN_URL}">${JOIN_URL}</a><br>\r\n` +
  '</div></span></font></body></html>';

describe('extractTeamsJoinDetails', () => {
  test('takes the HTML join details Exchange writes below an HTML body byte for byte, and leaves the description', () => {
    const details = extractTeamsJoinDetails(htmlBody('Agenda: <b>locators</b>'));

    expect(details).toBe(HTML_DETAILS);
  });

  test('takes the plain-text join details from the heading line on, inside the font they were stored in', () => {
    const details = extractTeamsJoinDetails(textBody('Talk through locators.'));

    expect(details).toBe(
      '<font size="2"><span style="font-size:11pt;"><div class="PlainText">' +
        '\r\nMicrosoft Teams meeting<br>\r\n' +
        `Join: <a href="${SHORT_JOIN}">${SHORT_JOIN}</a><br>\r\n` +
        `System reference: <a href="${JOIN_URL}">${JOIN_URL}</a><br>\r\n` +
        '</div></span></font>',
    );
  });

  test('starts plain-text join details at the separator line above the heading', () => {
    const details = extractTeamsJoinDetails(textBody('Talk through locators.', true));

    expect(details).toMatch(
      /^<font size="2"><span style="font-size:11pt;"><div class="PlainText">\r\n_{80}<br>\r\nMicrosoft/,
    );
    expect(details).not.toContain('Talk through locators.');
  });

  test('finds plain-text join details below an empty description', () => {
    const body =
      '<html><body><div class="PlainText">Microsoft Teams meeting<br>' +
      `Join: <a href="${SHORT_JOIN}">${SHORT_JOIN}</a><br></div></body></html>`;

    expect(extractTeamsJoinDetails(body)).toBe(
      `<div class="PlainText">Microsoft Teams meeting<br>Join: <a href="${SHORT_JOIN}">${SHORT_JOIN}</a><br></div>`,
    );
  });

  test('takes plain-text join details kept by an earlier edit, without the description that edit wrote', () => {
    // Exchange's layout after one body edit: the new HTML description, then the converted plain-text details.
    const details =
      '\r\n<font size="2"><span style="font-size:11pt">\r\n<div class="PlainText">Microsoft Teams meeting<br>\r\n' +
      `Join: <a href="${SHORT_JOIN}">\r\n${SHORT_JOIN}</a><br>\r\n</div>\r\n</span></font>`;
    const body =
      '<html><head></head><body>\r\n<div style="font-family:Aptos; font-size:12pt">\r\nUpdated agenda:<br>\r\n' +
      `- Locators</div>\r\n<br>${details}\r\n</body>\r\n</html>\r\n`;

    expect(extractTeamsJoinDetails(body)).toBe(details);
  });

  test('reopens the elements an HTML details container is nested in', () => {
    const body = `<html><body><div class="WordSection1"><p>Agenda</p>${HTML_DETAILS}</div></body></html>`;

    expect(extractTeamsJoinDetails(body)).toBe(`<div class="WordSection1">${HTML_DETAILS}</div>`);
  });

  test('returns null for a body without join details', () => {
    expect(extractTeamsJoinDetails('<html><body><p>Lunch at noon</p></body></html>')).toBeNull();
    expect(extractTeamsJoinDetails(`<html><body><a href="${SHORT_JOIN}">${SHORT_JOIN}</a></body></html>`)).toBeNull();
  });
});

describe('linksTo', () => {
  test('matches a link to the exact URL only', () => {
    expect(linksTo(htmlBody('Agenda'), JOIN_URL)).toBe(true);
    expect(linksTo(`<p>${JOIN_URL}</p>`, JOIN_URL)).toBe(false);
    expect(linksTo(htmlBody('Agenda'), `${JOIN_URL}x`)).toBe(false);
  });
});
