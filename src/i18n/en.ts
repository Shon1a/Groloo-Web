/* English is the offline fallback dictionary — every key the UI can request
 * resolves here if the active language file (loaded from the translations CDN)
 * is missing that key.
 *
 * EN_BASE is the full 481-key canonical table auto-extracted from the vanilla
 * assets/js/i18n.js (so keys align with the external groloo-translations repo).
 * SEED below carries the React app's additional/renamed keys and overrides base
 * where the wording was refined. Exported EN = { ...EN_BASE, ...SEED }. */
import { EN_BASE } from './en-base';

const SEED: Record<string, string> = {
  // primary nav (top strip + rail + drawer)
  'nav.home': 'Home',
  'nav.tv': 'TV',
  // The TV build's top menu bar labels the /tv page "Series" (its own key so the desktop
  // rail can keep saying "TV" untouched).
  'nav.series': 'Series',
  // TV home spotlight row heading.
  'tv.featured': 'Featured',
  'nav.tv_shows': 'TV Shows',
  'nav.movies': 'Movies',
  'nav.new_popular': 'New & Popular',
  'nav.my_list': 'My List',
  'nav.search': 'Search',
  'nav.anime': 'Anime',
  // Plural: it labels the rail item for /categories, which lists many. It read
  // "Category" among Movies/Anime/Settings, and was the only key in this group that
  // diverged from en-base — every sibling above restates it. Not a width workaround
  // either: the open rail leaves ~156px for the label and "My Space" already ships.
  'nav.categories': 'Categories',

  // Categories hub page
  'cathub.title': 'Browse by category',
  'cathub.sub': 'Jump straight into a collection, a genre, or a streaming service.',
  'cathub.collections': 'Collections',
  'cathub.genres': 'Genres',
  'cathub.networks': 'Networks',
  'nav.addons': 'Addons',
  'nav.settings': 'Settings',
  'nav.admin': 'Admin',
  'myspace.title': 'My Space',

  // ui chrome
  'ui.featured_title': 'Featured title',
  'ui.featured_titles': 'Featured titles',
  'ui.scroll_left': 'Scroll left',
  'ui.scroll_right': 'Scroll right',
  'ui.show': 'Show',

  // cards / rails
  'poster.view_details': 'view details',
  'type.movie': 'Movie',
  'type.series': 'Series',
  'cat.see_all': 'see all',
  'cat.browse_titles': 'browse titles',
  'cat.back': 'Back',
  'continue.remove': 'Remove from Continue Watching',

  // home row titles
  'sec.trending_movies': 'Trending Movies',
  'sec.trending_shows': 'Trending Shows',
  'sec.top_movies': 'Top Rated Movies',
  'sec.top_shows': 'Top Rated Shows',
  'sec.trending_anime': 'Trending Anime',
  'sec.top_anime': 'Top Rated Anime',
  'sec.netflix': 'Netflix',
  'sec.disney': 'Disney+',
  'sec.prime': 'Prime Video',
  'sec.apple': 'Apple TV+',
  'sec.max': 'HBO Max',
  'sec.paramount': 'Paramount+',
  'sec.crunchyroll': 'Crunchyroll',
  'sec.studios': 'Studios',
  // "& Series" is load-bearing: Home renders <UpcomingMarquee movies={…} series={…} />
  // and /api/home returns upcoming.movie AND upcoming.series, so the rail is both.
  // en-base and ka.json ("მომავალი ფილმები და სერიალები") both say movies and series;
  // this override kept the title-case refinement but dropped half the heading.
  'sec.upcoming_movies': 'Upcoming Movies & Series',

  // hero actions
  'hero.play': 'MORE',
  'hero.plot_fallback': '',

  // footer
  'footer.disclaimer':
    'GROLOO hosts no video files and stores no media on its servers. The catalog shows descriptive metadata only; any playable sources come from third-party add-ons you install, and your browser connects to them directly.',
  'footer.terms_link': 'Terms & Conditions',
  'footer.legal_link': 'DMCA / Takedown Policy',

  // legal page — the attributions pointer and the "where do I delete my account"
  // answer that legal.privacy_body has always implied without ever naming a route
  'legal.privacy_delete': 'To delete your account, open Settings → Account & legal and choose “Delete account”. Deletion is immediate and permanent: it removes your profile, your saved list, your watch history and positions, and your installed add-on collection from our servers.',
  'legal.attrib_head': 'Attributions & licences',
  'legal.attrib_body': 'Catalog metadata, artwork, and streaming-availability data are supplied by third parties whose terms require us to credit them, and part of the app is open-source software carried under its own licence.',
  'legal.attrib_link': 'Attributions & licences',

  // attributions screen — the notices themselves are hard-coded English in
  // Attributions.tsx (TMDB requires their sentence verbatim, and a licence is only
  // reproduced if it is reproduced); only this framing prose is translatable
  'attrib.title': 'Attributions & Licences',
  'attrib.updated': 'Last updated: July 2026',
  'attrib.intro': 'GROLOO is assembled from data and code published by other people. The notices boxed below are the conditions we display them under, and are reproduced in English exactly as worded — they are not translated, because a reworded notice is no longer the notice.',
  'attrib.tmdb_head': 'Catalog metadata & artwork — TMDB',
  'attrib.tmdb_body': 'Titles, synopses, cast and crew, ratings, posters, and backdrops come from The Movie Database. TMDB does not operate GROLOO, has no involvement in which add-ons you install, and has no connection to anything those add-ons make available.',
  'attrib.jw_head': 'Streaming availability — JustWatch',
  'attrib.jw_body': 'The “watch on” services listed against a title come from TMDB’s watch-provider data, which is sourced from JustWatch. Availability is per-country and changes without notice; GROLOO neither verifies nor resells any subscription, and links out to the service itself.',
  'attrib.heart_head': 'Groloo Heart — MIT licence',
  'attrib.heart_body': 'The catalog and library engine that runs inside your browser is Groloo Heart, released under the MIT licence. Its full notice is reproduced below.',
  'attrib.addons_head': 'Add-ons',
  'attrib.addons_body': 'Community add-ons are written, published, and licensed by their own authors. They are neither developed nor endorsed by GROLOO, and each one carries whatever licence and terms its author chose — see the add-on itself for those.',

  // detail modal
  'modal.watch': 'WATCH',
  'modal.watch_authed': 'WATCH',
  'modal.resume': 'RESUME',
  'modal.close_aria': 'Close details',
  'modal.unmute': 'Unmute trailer',
  'modal.mute': 'Mute trailer',
  'modal.loading_synopsis': 'Loading synopsis…',
  'modal.no_synopsis': 'No synopsis available.',
  'modal.episodes': 'EPISODES',
  'modal.streams': 'SOURCES',
  'modal.cast_credits': 'CASTS & CREDITS',
  'modal.show_all': 'SHOW ALL',
  'modal.show_less': 'SHOW LESS',
  'modal.director': 'Director',
  'modal.creator': 'Creator',
  'modal.as': 'as {name}',
  'modal.you_may_like': 'You may like',
  'modal.pick_episode': 'Pick an episode to see sources.',
  'modal.no_streams': 'No sources yet — install a streaming add-on to play.',
  'modal.signin_addon': 'Sign in to install your add-on.',
  'modal.tab_streaming': 'Streaming Services',
  'modal.tab_addons': 'Addon Sources',
  'modal.watch_on': 'Watch on {name}',
  'modal.no_providers': 'No streaming services listed for this title.',
  // A COUNT, not an ordinal — DetailModal renders it as "1 Season · 10 Episodes" when
  // meta.seasons === 1, pairing with 'modal.seasons_count' ("{n} Seasons"). Do not
  // "align" it with 'modal.season' below: that one IS an ordinal, for the season tabs.
  // ka.json has this right ("1 სეზონი" = 1 season), so English was the odd one out.
  'modal.season_one': '1 Season',
  'modal.season': 'Season {n}',
  'modal.seasons_count': '{n} Seasons',
  'modal.episodes_count': '{n} Episodes',
  'modal.episode_n': 'Episode {n}',
  'modal.episodes_unavailable': 'Episodes unavailable.',
  'modal.trailer_title': 'Trailer: {title}',
  'mylist.add': 'Add to My List',
  'mylist.remove': 'Remove from My List',

  // video player
  'player.preparing': 'Preparing stream…',
  'player.close': 'Close player',
  'ctl.play_a': 'Play or pause',
  'ctl.back_a': 'Back 10 seconds',
  'ctl.fwd_a': 'Forward 10 seconds',
  'ctl.mute_a': 'Mute',
  'ctl.vol_a': 'Volume',
  'ctl.subs_a': 'Toggle subtitles',
  'ctl.settings_a': 'Playback settings',
  'ctl.pip_a': 'Picture in picture',
  'ctl.fs_a': 'Toggle fullscreen',
  'ctl.grain': 'Grain',
  'ctl.clarity': 'Clarity',

  // discover / search / grid
  'search.ph': 'Search titles, people, genres…',
  'search.aria': 'Search titles, people, and genres',
  'filter.type': 'TYPE',
  'filter.all': 'All',
  'filter.movies': 'Movies',
  'filter.series': 'Series',
  'filter.genre': 'GENRE',
  'filter.year': 'YEAR',
  'filter.rating': 'RATING',
  'filter.clear': 'Clear all ✕',
  'filter.any_year': 'any year',
  'filter.any_rating': 'any rating',
  'grid.load_more': 'Load more',
  'grid.loading': 'Loading…',
  'grid.no_results': 'No results for “{q}”.',
  'grid.no_titles': 'No titles found.',
  'cat.page': 'Page {x} of {y}',
  'cat.filtered': 'Filtered titles',
  'explore.results': 'Results for “{q}”',
  'explore.trending': 'Trending now',

  // continue watching
  'sec.continue': 'Continue Watching',

  // my space / my list
  'mylist.empty': 'Your list is empty. Add titles with the + button.',
  'myspace.my_list': 'My List',

  // settings
  'settings.title': 'Settings',
  // AUDIO language, not the UI's. It labels the select bound to settings.audioLang
  // (English / Original) in the Playback card, and Settings already has a separate
  // 'settings.website_language' control — a bare "Language" leaves the reader to guess
  // which is which. en-base and ka.json ("აუდიო ენა") both say audio; this override
  // was the odd one out.
  'settings.language': 'Audio language',
  'settings.autoplay_next': 'Auto-play next episode',
  'settings.sub_size': 'Subtitle size',
  'settings.blur_unwatched': 'Blur unwatched episode stills',
  // colour picker — the saturation/brightness square and the hue rail have no visible
  // label of their own, so they carry aria-only names (_a, per ctl.play_a / ui.nav_toggle_a).
  // The trigger reuses the row's visible settings.sub_color / sub_outline key instead.
  'settings.sub_sat_a': 'Saturation',
  'settings.sub_val_a': 'Brightness',
  'settings.sub_hue_a': 'Hue',
  // Account & legal card — deletion has to be reachable from inside the app for both
  // stores, and Attributions has to be reachable from Settings once the TV shells drop
  // the web footer that currently carries the only links to the legal pages.
  'settings.account_head': 'ACCOUNT & LEGAL',
  'settings.account_desc': 'Credits, licences, and removing your account',
  'settings.attributions': 'Attributions & licences',
  'settings.view': 'View',
  'settings.delete_what': 'Deleting your account is immediate and cannot be undone. It removes your profile, your saved list, your watch history and playback positions, and your installed add-on collection from our servers. Playback preferences held only in this browser stay until you clear it.',
  'settings.delete_account': 'Delete account',
  'settings.delete_confirm': 'Yes, delete permanently',
  'settings.delete_cancel': 'Keep my account',
  'settings.deleting': 'Deleting…',
  'settings.delete_err': 'Could not delete your account. Please try again.',

  // Public /delete-account page — the standalone, no-login-required URL Play has demanded
  // of every app with account creation since 2024-05-31, and the destination en-base's
  // legal.privacy_body has always promised. It is NOT a duplicate of the Settings card
  // above: that one is reached only by someone already signed in and already inside the
  // app, while this one has to stand alone for a reviewer or an ex-user who has deleted
  // the app and arrived cold from a store listing. So the copy here re-states the whole
  // story — what goes, what does not, that it cannot be undone — instead of assuming any
  // surrounding context, and the page reuses the ACTION strings from the settings group
  // (settings.delete_account / _confirm / _cancel / settings.deleting / settings.delete_err)
  // rather than shipping a second set of translations for identical buttons.
  'deleteAccount.title': 'Delete your GROLOO account',
  'deleteAccount.lede': 'This page deletes a GROLOO account and everything stored against it. You do not need the app installed to use it — signing in here is enough.',
  'deleteAccount.what_head': 'What gets deleted',
  // Enumerated deliberately and matched to what deleteUserAccount actually removes on the
  // server (the user record, the library document, the add-ons document, every session).
  // A vague "your data" here is the sentence a store reviewer rejects, and the one a
  // regulator reads against what the code does.
  'deleteAccount.what': 'Deleting removes your account record — your email address, your password, and any linked Google sign-in — along with your saved list, your watch history and playback positions, your installed add-on collection, and every session signed in to the account. Nothing is kept in a recoverable form and nothing is held back for reactivation.',
  'deleteAccount.what_local': 'Preferences that never left your device — playback settings, subtitle styling, and your chosen language — are stored in your browser or TV app, not on our servers. Deletion does not reach them; clear the app or site data to remove those too.',
  'deleteAccount.irreversible': 'This cannot be undone. There is no grace period, no archive, and no way for us to restore an account afterwards — to use GROLOO again you would have to create a new one.',
  'deleteAccount.signin_head': 'Sign in to continue',
  // Says the quiet part out loud: people arriving at a page titled "Delete your account"
  // are wary of a sign-in form on it, and the one thing that defuses that is promising
  // the credentials do not themselves trigger the deletion.
  'deleteAccount.signin_prompt': 'Only the account holder can delete an account, so sign in with the account you want removed. Signing in does nothing on its own — you still have to confirm on the next step.',
  'deleteAccount.signed_in_as': 'Signed in as {email}',
  'deleteAccount.done_head': 'Your account has been deleted',
  'deleteAccount.done_body': 'Your profile, your list, your history, and your add-ons are gone from our servers, and every device signed in to that account has been signed out. There is nothing left to do.',

  // addons
  'addons.title': 'Add-ons',
  'addons.install': 'Install',
  'addons.none': 'No community add-ons yet.',
  'addons.sync_note': 'Signed in? Your add-ons sync across your devices.',
  'addons.configure': 'Configure',
  'addons.enable': 'Add',
  'addons.remove': 'Remove',

  // UNLINKED ADD-ONS — the second-device state, and the hardest copy on this screen to
  // get right. A configured community add-on packs the user's provider key into its URL
  // (Stremio convention), so the account deliberately remembers WHICH add-ons they run
  // and never HOW to reach them. The consequence lands entirely on the user: sign in on a
  // TV and the add-ons they own arrive with no URL, unusable until they paste it again.
  //
  // Everything below is written so that reads as a PROPERTY, not a fault. Two rules the
  // wording follows and translations should keep: (1) never apologise and never use
  // failure words — nothing broke, nothing was lost, the add-ons are still theirs; (2)
  // say plainly WHY the link is missing before asking for it, because "paste it again"
  // with no reason reads as the app having mislaid something. The one thing the user has
  // to walk away understanding is that the link only ever existed on the device they
  // typed it into — that is the whole trade, and it is the reason their key is not
  // sitting in our database waiting to be breached.
  'addons.unlinked_head': 'Needs its link on this device',
  'addons.unlinked_count': '{n} waiting',
  'addons.unlinked_why': 'Your account remembers which add-ons you use — never the links themselves. A configured add-on carries your provider key inside its own URL, so that URL is kept only on the device you typed it into: we never store it, which also means it cannot follow you here. These add-ons are still yours and still on your account. This device just needs each link once, and then it works exactly as it does everywhere else.',
  'addons.unlinked_tag': 'Link needed',
  // Shown in place of the origin on rows old enough to predate the server keeping one.
  // Lower case: it sits where a hostname would, and should not read as a heading.
  'addons.unlinked_origin_unknown': 'source not recorded',
  'addons.unlinked_row_hint': 'paste this add-on’s install link to use it here',
  'addons.unlinked_relink': 'Paste link',
  // Armed when a row's button is pressed and shown above the install box, which is where
  // the eye has just been sent. It names the add-on so the field cannot be typed into
  // blind, and repeats where the link is, because "the same link" is useless advice to
  // someone who does not know it still exists on the other device.
  'addons.relink_prompt': 'Pasting the install link for {name}. Use the same link you installed it with — the copy on your other device is the only one there is.',
  'addons.relink_cancel': 'Cancel',
  // The dead-rail line in AddonRows' per-row ErrorBoundary fallback. Deliberately blames
  // nothing and offers no action: the user did not break it, cannot fix it, and the row's
  // own title is already on screen above this — so it says what happened and stops.
  'addons.row_failed': 'This add-on row could not be shown.',

  // Root crash panel (ErrorBoundary's default fallback). It renders when the app has
  // already failed, so the wording assumes the reader has lost the screen they were on
  // and needs one instruction, not an apology. RELOAD is caps to match the other primary
  // buttons that share .auth-submit (auth.login_cta, modal.watch) — a translation may
  // drop the caps where the script has no case, that is the translator's call.
  'error.title': 'Something went wrong',
  'error.body': 'Groloo hit an unexpected error and stopped drawing this screen.',
  'error.reload': 'RELOAD',

  // auth
  'auth.kicker': '// sign in to manage add-ons & settings',
  'auth.tab_login': 'LOG IN',
  'auth.tab_signup': 'SIGN UP',
  'auth.or': 'or',
  'auth.name': 'FIRST NAME',
  'auth.surname': 'SURNAME',
  'auth.dob': 'DATE OF BIRTH',
  'auth.dob_hint': 'GROLOO is an 18+ service — we ask only to confirm you are old enough.',
  'auth.email': 'EMAIL',
  'auth.password': 'PASSWORD',
  'auth.show': 'SHOW',
  'auth.hide': 'HIDE',
  'auth.pass_hint': 'min 8 characters · 1 letter · 1 number',
  'auth.login_cta': 'LOG IN ▶',
  'auth.signup_cta': 'CREATE ACCOUNT ▶',
  'auth.switch_no_account': 'No account?',
  'auth.switch_have_account': 'Already have an account?',
  'auth.create_one': 'Create one →',
  'auth.login_link': 'Log in →',
  'auth.note': 'Browsing the catalog stays open — sign in only to install add-ons.',
  'auth.dismiss_aria': 'Close and keep browsing the catalog',
  'auth.err_email': 'Enter a valid email address.',
  'auth.err_pass': 'Password must be at least 8 characters with a letter and a number.',
  // 18, matching the Terms' eligibility clause — the number in the message and the
  // number in AuthModal's MIN_AGE have to move together or the copy lies.
  'auth.err_age': 'You must be at least 18 years old to create an account.',
  'auth.err_generic': 'Something went wrong. Please try again.',
  'auth.signin': 'Sign in',

  // device link (#/link) — the phone-side claim screen for a code shown on a TV.
  // Every string here is read on a 5" screen by someone who has just been told to
  // "go to groloo.vercel.app/link", so it stays short and names the TV, not the
  // protocol. The warning is not decoration: reverse phishing (someone sends you a
  // code and your account signs into THEIR TV) is the one attack RFC 8628 cannot
  // close, and this sentence is the mitigation. It leads, and it must keep leading.
  'link.title': 'Link a TV',
  'link.lede': 'Signing in on a TV is easier from here. Enter the code your TV is showing and we’ll sign it in to this account.',
  'link.warn': 'Only enter a code you can see on a TV in front of you — never a code someone sent you.',
  'link.code_label': 'Code from your TV',
  'link.code_hint': 'Eight characters — spaces and dashes don’t matter.',
  'link.continue': 'Continue',
  'link.checking': 'Checking…',
  'link.signin_cta': 'Sign in to continue',
  'link.signin_why': 'Linking signs your TV into your account, so we need to know whose it is. Your code is kept while you sign in.',

  'link.confirm_head': 'Sign this device in?',
  'link.confirm_body': 'This signs the device below in as {email}, and it stays signed in until you sign it out there.',
  'link.device_prefix': 'The device asking is described as:',
  'link.device_unknown': 'A device that didn’t say what it is',
  'link.expires_in': 'This code expires in {time}',
  'link.approve': 'Yes, sign it in',
  'link.approving': 'Signing in…',
  'link.deny': 'No, that isn’t my TV',
  'link.denying': 'Rejecting…',

  'link.done_head': 'Your TV is signed in',
  'link.done_body': 'It should show {email} within a few seconds. You can close this page.',
  'link.rejected_head': 'Request rejected',
  'link.rejected_body': 'Nothing was signed in, and the code is now dead. If it really was your own TV, get a new code there and try again.',
  'link.another': 'Link another device',

  // Wording tracks the server's messages for the same machine codes — a user who sees
  // both (page copy here, raw API text in a support screenshot) should read one story.
  'link.err_invalid': 'That code doesn’t look right — check the characters on your TV.',
  'link.err_expired': 'That pairing code has expired — get a new one on your TV.',
  'link.err_used': 'That code has already been used. Get a new one on your TV.',
  'link.err_rate': 'Too many attempts. Wait a few minutes, then try again.',
  'link.err_signedout': 'Your session ended. Sign in again to link your TV.',
  'link.err_generic': 'Something went wrong. Please try again.',

  // What the device SAYS it is. Every word of it is self-reported by whoever asked for
  // the code and verified by nobody, which is why link.device_prefix frames the whole
  // block as a description rather than asserting it. Only `platform` is constrained —
  // the server coerces it to this enum — so it is the only part rendered from our own
  // vocabulary instead of theirs.
  'link.platform_webos': 'An LG TV (webOS)',
  'link.platform_androidtv': 'An Android TV device',
  'link.platform_tizen': 'A Samsung TV (Tizen)',
  'link.platform_browser': 'A web browser',
  'link.platform_other': 'A device',

  'common.loading': 'Loading…',

  /* Reporting and blocking — Google Play's User Generated Content policy requires
   * in-app reporting, a blocking mechanism, accepted terms and demonstrable action.
   *
   * The wording avoids promising an outcome anywhere. "We review every report" is a
   * commitment to a human process; "Thanks — we'll take a look" is not, and only one of
   * them is true for a service run by one person. The Terms already carry the
   * repeat-infringer clause that gives the queue its teeth, so the sheet does not need
   * to restate it. */
  'report.cta': 'Report',
  'report.title': 'Report this',
  'report.reason_head': 'What is wrong with it?',
  'report.reason_copyright': 'Copyright infringement',
  'report.reason_illegal': 'Illegal content',
  'report.reason_malware': 'Malware or unsafe links',
  'report.reason_sexual': 'Sexual or explicit content',
  'report.reason_violence': 'Violence or hate',
  'report.reason_misleading': 'Misleading or spam',
  'report.reason_other': 'Something else',
  // Stated inside the sheet rather than after submission, so someone who came to file a
  // formal notice can still act on it. The address is the designated agent in the Terms.
  'report.copyright_note': 'Formal copyright notices go to our designated agent — see the DMCA policy in the Terms. Reporting here flags it for review but is not a takedown notice.',
  'report.detail_label': 'Anything else? (optional)',
  'report.detail_ph': 'What did you see?',
  'report.also_block_addon': 'Also hide this add-on from my apps',
  'report.also_block_title': 'Also hide this title from my apps',
  'report.submit': 'Send report',
  'report.sending': 'Sending…',
  'report.done': 'Close',
  'report.sent_title': 'Report sent',
  'report.sent_body': 'Thanks — this has been added to the review queue.',
  'report.footer': 'Groloo does not host any media. Add-ons are third-party services you chose to install.',
  'report.err_rate': "You've sent a lot of reports recently. Try again a little later.",
  'report.err_signedout': 'Your session ended. Sign in again to send this report.',
  'report.err_generic': 'Something went wrong. Please try again.',

  // Hiding is per-account and syncs across devices; the labels say "my apps" rather than
  // "this device" because that is what actually happens.
  // Sign-up terms acceptance. The sentence names what is being agreed to rather than
  // saying "the terms", because a checkbox whose label is a pronoun is not informed consent.
  'auth.terms_accept': "I'm 18 or over and I agree to the",
  'auth.terms_link': 'Terms',
  'auth.legal_link': 'DMCA & Takedown Policy',
  'auth.err_terms': 'Please accept the Terms to create an account.',

  'addons.hide': 'Hide',
  'addons.unhide': 'Unhide',
  'addons.hidden_tag': 'Hidden',
  'blocks.hidden_note': 'Hidden by you. Its catalogs stay out of Home, Search and Browse until you unhide it.',
};

export const EN: Record<string, string> = { ...EN_BASE, ...SEED };
