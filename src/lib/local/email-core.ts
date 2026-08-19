// =============================================================================
// EMAIL VALIDATION — structure, real TLDs, disposable domains, did-you-mean
// =============================================================================
// Pure logic, no imports, so it loads in three places at once: the signup API
// route, the client-side /signup form, and `node --test`. Keep it that way —
// see README → Testing.
//
// The rule that matters: `layla@email.con` is not a valid address. The old regex
// (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) and `type="email"` both accept it, because
// both only check for shape. `.con` is not a delegated TLD, so nothing can ever
// be delivered there, and the guest waits for an OTP that will never arrive.
// The only way to know is to check the extension against the IANA root zone.
// =============================================================================

/** Longest address an SMTP path accepts (RFC 5321), and its local part. */
export const MAX_EMAIL_LENGTH = 254
const MAX_LOCAL_LENGTH = 64
const MAX_LABEL_LENGTH = 63

// ---- The IANA root zone --------------------------------------------------
// Every delegated top-level domain, lowercased, space-separated. Refreshed from
// https://data.iana.org/TLD/tlds-alpha-by-domain.txt
// Version 2026081600, Last Updated Sun Aug 16 07:07:01 2026 UTC
// New TLDs are delegated a few times a year; `npm run check:tlds` reports drift.

const TLD_DATA =
  "aaa aarp abb abbott abbvie abc able abogado abudhabi ac academy accenture accountant " +
  "accountants aco actor ad ads adult ae aeg aero aetna af afl africa ag agakhan agency " +
  "ai aig airbus airforce airtel akdn al alibaba alipay allfinanz allstate ally alsace " +
  "alstom am amazon americanexpress americanfamily amex amfam amica amsterdam analytics " +
  "android anquan anz ao aol apartments app apple aq aquarelle ar arab aramco archi " +
  "army arpa art arte as asda asia associates at athleta attorney au auction audi " +
  "audible audio auspost author auto autos aw aws ax axa az azure ba baby baidu banamex " +
  "band bank bar barcelona barclaycard barclays barefoot bargains baseball basketball " +
  "bauhaus bayern bb bbc bbt bbva bcg bcn bd be beats beauty beer berlin best bestbuy " +
  "bet bf bg bh bharti bi bible bid bike bing bingo bio biz bj black blackfriday " +
  "blockbuster blog bloomberg blue bm bms bmw bn bnpparibas bo boats boehringer bofa " +
  "bom bond boo book booking bosch bostik boston bot boutique box br bradesco " +
  "bridgestone broadway broker brother brussels bs bt build builders business buy buzz " +
  "bv bw by bz bzh ca cab cafe cal call calvinklein cam camera camp canon capetown " +
  "capital capitalone car caravan cards care career careers cars casa case cash casino " +
  "cat catering catholic cba cbn cbre cc cd center ceo cern cf cfa cfd cg ch chanel " +
  "channel charity chase chat cheap chintai christmas chrome church ci cipriani circle " +
  "cisco citadel citi citic city ck cl claims cleaning click clinic clinique clothing " +
  "cloud club clubmed cm cn co coach codes coffee college cologne com commbank " +
  "community company compare computer comsec condos construction consulting contact " +
  "contractors cooking cool coop corsica country coupon coupons courses cpa cr credit " +
  "creditcard creditunion cricket crown crs cruise cruises cu cuisinella cv cw cx cy " +
  "cymru cyou cz dad dance data date dating datsun day dclk dds de deal dealer deals " +
  "degree delivery dell deloitte delta democrat dental dentist desi design dev dhl " +
  "diamonds diet digital direct directory discount discover dish diy dj dk dm dnp do " +
  "docs doctor dog domains dot download drive dtv dubai dupont durban dvag dvr dz earth " +
  "eat ec eco edeka edu education ee eg email emerck energy engineer engineering " +
  "enterprises epson equipment er ericsson erni es esq estate et eu eurovision eus " +
  "events exchange expert exposed express extraspace fage fail fairwinds faith family " +
  "fan fans farm farmers fashion fast fedex feedback ferrari ferrero fi fidelity fido " +
  "film final finance financial fire firestone firmdale fish fishing fit fitness fj fk " +
  "flickr flights flir florist flowers fly fm fo foo food football ford forex forsale " +
  "forum foundation fox fr free fresenius frl frogans frontier ftr fujitsu fun fund " +
  "furniture futbol fyi ga gal gallery gallo gallup game games gap garden gay gb gbiz " +
  "gd gdn ge gea gent genting george gf gg ggee gh gi gift gifts gives giving gl glass " +
  "gle global globo gm gmail gmbh gmo gmx gn godaddy gold goldpoint golf goodyear goog " +
  "google gop got gov gp gq gr grainger graphics gratis green gripe grocery group gs gt " +
  "gu gucci guge guide guitars guru gw gy hair hamburg hangout haus hbo hdfc hdfcbank " +
  "health healthcare help helsinki here hermes hiphop hisamitsu hitachi hiv hk hkt hm " +
  "hn hockey holdings holiday homedepot homegoods homes homesense honda horse hospital " +
  "host hosting hot hotels hotmail house how hr hsbc ht hu hughes hyatt hyundai ibm " +
  "icbc ice icu id ie ieee ifm ikano il im imamat imdb immo immobilien in inc " +
  "industries infiniti info ing ink institute insurance insure int international intuit " +
  "investments io ipiranga iq ir irish is ismaili ist istanbul it itau itv jaguar java " +
  "jcb je jeep jetzt jewelry jio jll jm jmp jnj jo jobs joburg jot joy jp jpmorgan jprs " +
  "juegos juniper kaufen kddi ke kerryhotels kerryproperties kfh kg kh ki kia kids kim " +
  "kindle kitchen kiwi km kn koeln komatsu kosher kp kpmg kpn kr krd kred kuokgroup kw " +
  "ky kyoto kz la lacaixa lamborghini lamer land landrover lanxess lasalle lat latino " +
  "latrobe law lawyer lb lc lds lease leclerc lefrak legal lego lexus lgbt li lidl life " +
  "lifeinsurance lifestyle lighting like lilly limited limo lincoln link live living lk " +
  "llc llp loan loans locker locus lol london lotte lotto love lpl lplfinancial lr ls " +
  "lt ltd ltda lu lundbeck luxe luxury lv ly ma madrid maif maison makeup man " +
  "management mango map market marketing markets marriott marshalls mattel mba mc " +
  "mckinsey md me med media meet melbourne meme memorial men menu merck merckmsd mg mh " +
  "miami microsoft mil mini mint mit mitsubishi mk ml mlb mls mm mma mn mo mobi mobile " +
  "moda moe moi mom monash money monster mormon mortgage moscow moto motorcycles mov " +
  "movie mp mq mr ms msd mt mtn mtr mu museum music mv mw mx my mz na nab nagoya name " +
  "navy nba nc ne nec net netbank netflix network neustar new news next nextdirect " +
  "nexus nf nfl ng ngo nhk ni nico nike nikon ninja nissan nissay nl no nokia norton " +
  "now nowruz nowtv np nr nra nrw ntt nu nyc nz obi observer office okinawa olayan " +
  "olayangroup ollo om omega one ong onl online ooo open oracle orange org organic " +
  "origins osaka otsuka ott ovh pa page panasonic paris pars partners parts party pay " +
  "pccw pe pet pf pfizer pg ph pharmacy phd philips phone photo photography photos " +
  "physio pics pictet pictures pid pin ping pink pioneer pizza pk pl place play " +
  "playstation plumbing plus pm pn pnc pohl poker politie porn post pr praxi press " +
  "prime pro prod productions prof progressive promo properties property protection pru " +
  "prudential ps pt pub pw pwc py qa qpon quebec quest racing radio re read realestate " +
  "realtor realty recipes red redumbrella rehab reise reisen reit reliance ren rent " +
  "rentals repair report republican rest restaurant review reviews rexroth rich " +
  "richardli ricoh ril rio rip ro rocks rodeo rogers room rs rsvp ru rugby ruhr run rw " +
  "rwe ryukyu sa saarland safe safety sakura sale salon samsclub samsung sandvik " +
  "sandvikcoromant sanofi sap sarl sas save saxo sb sbi sbs sc scb schaeffler schmidt " +
  "scholarships school schule schwarz science scot sd se search seat secure security " +
  "seek select sener services seven sew sex sexy sfr sg sh shangrila sharp shell shia " +
  "shiksha shoes shop shopping shouji show si silk sina singles site sj sk ski skin sky " +
  "skype sl sling sm smart smile sn sncf so soccer social softbank software sohu solar " +
  "solutions song sony soy spa space sport spot sr srl ss st stada staples star " +
  "statebank statefarm stc stcgroup stockholm storage store stream studio study style " +
  "su sucks supplies supply support surf surgery suzuki sv swatch swiss sx sy sydney " +
  "systems sz tab taipei talk taobao target tatamotors tatar tattoo tax taxi tc tci td " +
  "tdk team tech technology tel temasek tennis teva tf tg th thd theater theatre tiaa " +
  "tickets tienda tips tires tirol tj tjmaxx tjx tk tkmaxx tl tm tmall tn to today " +
  "tokyo tools top toray toshiba total tours town toyota toys tr trade trading training " +
  "travel travelers travelersinsurance trust trv tt tube tui tunes tushu tv tvs tw tz " +
  "ua ubank ubs ug uk unicom university uno uol ups us uy uz va vacations vana vanguard " +
  "vc ve vegas ventures verisign versicherung vet vg vi viajes video vig viking villas " +
  "vin vip virgin visa vision viva vivo vlaanderen vn vodka volvo vote voting voto " +
  "voyage vu wales walmart walter wang wanggou watch watches weather weatherchannel web " +
  "webcam weber website wed wedding weibo weir wf whoswho wien wiki williamhill win " +
  "windows wine winners wme woodside work works world wow ws wtc wtf xbox xerox xihuan " +
  "xin xn--11b4c3d xn--1ck2e1b xn--1qqw23a xn--2scrj9c xn--30rr7y xn--3bst00m " +
  "xn--3ds443g xn--3e0b707e xn--3hcrj9c xn--3pxu8k xn--42c2d9a xn--45br5cyl xn--45brj9c " +
  "xn--45q11c xn--4dbrk0ce xn--4gbrim xn--54b7fta0cc xn--55qw42g xn--55qx5d " +
  "xn--5su34j936bgsg xn--5tzm5g xn--6frz82g xn--6qq986b3xl xn--80adxhks xn--80ao21a " +
  "xn--80aqecdr1a xn--80asehdb xn--80aswg xn--8y0a063a xn--90a3ac xn--90ae xn--90ais " +
  "xn--9dbq2a xn--9et52u xn--9krt00a xn--b4w605ferd xn--bck1b9a5dre4c xn--c1avg " +
  "xn--c2br7g xn--cck2b3b xn--cckwcxetd xn--cg4bki xn--clchc0ea0b2g2a9gcd xn--czr694b " +
  "xn--czrs0t xn--czru2d xn--d1acj3b xn--d1alf xn--e1a4c xn--eckvdtc9d xn--efvy88h " +
  "xn--fct429k xn--fhbei xn--fiq228c5hs xn--fiq64b xn--fiqs8s xn--fiqz9s xn--fjq720a " +
  "xn--flw351e xn--fpcrj9c3d xn--fzc2c9e2c xn--fzys8d69uvgm xn--g2xx48c xn--gckr3f0f " +
  "xn--gecrj9c xn--gk3at1e xn--h2breg3eve xn--h2brj9c xn--h2brj9c8c xn--hxt814e " +
  "xn--i1b6b1a6a2e xn--imr513n xn--io0a7i xn--j1aef xn--j1amh xn--j6w193g " +
  "xn--jlq480n2rg xn--jvr189m xn--kcrx77d1x4a xn--kprw13d xn--kpry57d xn--kput3i " +
  "xn--l1acc xn--lgbbat1ad8j xn--mgb9awbf xn--mgba3a3ejt xn--mgba3a4f16a " +
  "xn--mgba7c0bbn0a xn--mgbaam7a8h xn--mgbab2bd xn--mgbah1a3hjkrd xn--mgbai9azgqp6j " +
  "xn--mgbayh7gpa xn--mgbbh1a xn--mgbbh1a71e xn--mgbc0a9azcg xn--mgbca7dzdo " +
  "xn--mgbcpq6gpa1a xn--mgberp4a5d4ar xn--mgbgu82a xn--mgbi4ecexp xn--mgbpl2fh " +
  "xn--mgbt3dhd xn--mgbtx2b xn--mgbx4cd0ab xn--mix891f xn--mk1bu44c xn--mxtq1m " +
  "xn--ngbc5azd xn--ngbe9e0a xn--ngbrx xn--node xn--nqv7f xn--nqv7fs00ema xn--nyqy26a " +
  "xn--o3cw4h xn--ogbpf8fl xn--otu796d xn--p1acf xn--p1ai xn--pgbs0dh xn--pssy2u " +
  "xn--q7ce6a xn--q9jyb4c xn--qcka1pmc xn--qxa6a xn--qxam xn--rhqv96g xn--rovu88b " +
  "xn--rvc1e0am3e xn--s9brj9c xn--ses554g xn--t60b56a xn--tckwe xn--tiq49xqyj " +
  "xn--unup4y xn--vermgensberater-ctb xn--vermgensberatung-pwb xn--vhquv xn--vuq861b " +
  "xn--w4r85el8fhu5dnra xn--w4rs40l xn--wgbh1c xn--wgbl6a xn--xhq521b xn--xkc2al3hye2a " +
  "xn--xkc2dl3a5ee0h xn--y9a3aq xn--yfro4i67o xn--ygbi2ammx xn--zfr164b xxx xyz yachts " +
  "yahoo yamaxun yandex ye yodobashi yoga yokohama you youtube yt yun za zappos zara " +
  "zero zip zm zone zuerich zw "

const VALID_TLDS = new Set(TLD_DATA.trim().split(' '))

/** Number of TLDs in the embedded root-zone snapshot (used by the drift check). */
export const TLD_COUNT = VALID_TLDS.size

/** True when [tld] is a delegated top-level domain. Case-insensitive. */
export function isKnownTld(tld: string): boolean {
  return VALID_TLDS.has(String(tld).trim().toLowerCase())
}

/** Common disposable / temp-mail domains we refuse at signup, login and email change. */
const DISPOSABLE_DOMAINS = new Set([
  // Mailinator + family
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'reallymymail.com',
  // Guerrilla Mail + aliases
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.info',
  'guerrillamail.biz', 'guerrillamail.de', 'guerrillamailblock.com', 'sharklasers.com',
  'grr.la', 'spam4.me', 'pokemail.net',
  // 10 minute mail
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '10minemail.com',
  // Temp-mail / tempmail family
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'temp-mail.com', 'tempmail.dev',
  'tempmail.net', 'tempmailo.com', 'tempmail.plus', 'tmpmail.org', 'tmpmail.net',
  'tmail.ws', 'tempinbox.com', 'tempr.email', 'temp-inbox.com', 'tempmailaddress.com',
  // Yopmail
  'yopmail.com', 'yopmail.net', 'yopmail.fr',
  // Throwaway
  'throwawaymail.com', 'throwaway.email', 'throwawayemailaddresses.com',
  // Nada / GetNada
  'getnada.com', 'nada.email',
  // Dispostable / Dispomail
  'dispostable.com', 'dispomail.eu',
  // Trashmail
  'trashmail.com', 'trashmail.de', 'trashmail.net', 'trashmail.org', 'trash-mail.com',
  // Maildrop / Mailnesia / Mailcatch / Maildim
  'maildrop.cc', 'mailnesia.com', 'mailcatch.com', 'mailpoof.com', 'mailnull.com',
  // Misc throwaways
  'fakeinbox.com', 'fakemail.net', 'mintemail.com', 'mohmal.com', 'emailondeck.com',
  'discard.email', 'moakt.com', 'inboxbear.com', 'harakirimail.com', 'byom.de',
  'anonbox.net', 'burnermail.io', 'einrot.com', 'mvrht.com', 'luxusmail.org',
  // 1secmail family
  '1secmail.com', '1secmail.net', '1secmail.org',
  // Other commonly-abused providers
  'getairmail.com', 'maileater.com', 'spambox.us', 'spamgourmet.com', 'mytemp.email',
  'tempemail.co', 'tempemails.io', 'mailtemp.net', 'inboxkitten.com', 'emailfake.com',
  'mailsac.com', 'mail.tm', 'mail7.io', 'wegwerfmail.de', 'wegwerfemail.de',
  // Added 2026-08-19 alongside the trusted-provider allowlist below. The
  // allowlist is only a fast path, so this list is the real gate for every
  // domain that isn't a known provider — it has to stay current. New temp-mail
  // services appear weekly; a signup from an unknown domain whose OTP is never
  // verified is the signal that one is missing.
  'yopmail.it', 'jetable.org', 'jetable.net', 'spamdecoy.net', 'trbvm.com',
  'incognitomail.com', 'incognitomail.org', 'deadaddress.com',
  'objectmail.com', 'proxymail.eu', 'rcpt.at', 'safetymail.info',
  'sofimail.com', 'spamavert.com', 'spambog.com', 'spamfree24.org',
  'spamherelots.com', 'spamhole.com', 'spamify.com', 'superrito.com',
  'teleworm.us', 'trash2009.com', 'trashdevil.com', 'trashymail.com',
  'tyldd.com', 'uggsrock.com', 'wilemail.com', 'willselfdestruct.com',
  'zetmail.com', 'armyspy.com', 'cuvox.de', 'dayrep.com', 'fleckens.hu',
  'gustr.com', 'jourrapide.com', 'rhyta.com', 'mailinator.org',
  'mailinator.us', 'binkmail.com', 'bobmail.info', 'devnullmail.com',
  'letthemeatspam.com', 'mailin8r.com', 'notmailinator.com', 'sogetthis.com',
  'suremail.info', 'thisisnotmyrealemail.com', 'tradermail.info',
  'veryrealemail.com', 'zippymail.info', 'mailexpire.com', 'meltmail.com',
  'mytrashmail.com', 'nospam4.us', 'nowmymail.com', 'shieldedmail.com',
  'sneakemail.com', 'spamex.com', 'spamslicer.com', 'tempalias.com',
  'tempmailer.com', 'tempsky.com', 'trashinbox.com', 'linshiyouxiang.net',
  'lroid.com', 'mailhazard.com', 'mailhz.me', 'mailmoat.com',
  'minuteinbox.com', 'mail-temporaire.fr', 'mailtothis.com', 'kurzepost.de',
  'onemoremail.net', 'crazymailing.com', 'emailtemporanea.net', 'emltmp.com',
  'etempmail.net', 'fakemailgenerator.com', 'generator.email',
  'gettempmail.com', 'inbox.si', 'inboxalias.com', 'instantemailaddress.com',
  'mail-easy.fr', 'mailbucket.org', 'mailforspam.com', 'mailguard.me',
  'mailimate.com', 'mailismagic.com', 'mailquack.com', 'mailseal.de',
  'mailtemporaire.fr', 'mytempemail.com', 'mytempmail.com',
  'sharklasers.net', 'spambox.info', 'tempail.com', 'tempemail.net',
  'tempimbox.com', 'tempmail2.com', 'tempsmail.com', 'tmails.net',
  'vomoto.com', 'zoemail.net',
])

// ---- The trusted-provider allowlist --------------------------------------
// The mailbox providers real guests and hosts actually use. A domain on this
// list is accepted immediately — no root-zone lookup, no blocklist walk —
// because we already know it is a real, permanent mailbox.
//
// This is a FAST PATH, not the whole policy. A domain missing from here is NOT
// refused: it falls through to the root-zone check and the disposable blocklist
// above, which is what keeps company addresses (`ahmed@orascom.com`),
// universities (`@aucegypt.edu`) and small providers working. An omission
// therefore costs nothing — never "tighten" this by deleting entries.
//
// `privaterelay.appleid.com` is load-bearing: Sign in with Apple hands us an
// address on that domain whenever the user chooses to hide their real one.
// Drop it and our own Apple sign-in stops being able to create accounts.

const TRUSTED_DOMAINS = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft — the global four plus the regional suffixes Egyptians carry
  // over from old Hotmail and MSN accounts.
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'windowslive.com',
  'outlook.sa', 'outlook.fr', 'outlook.de', 'outlook.es', 'outlook.it',
  'outlook.ie', 'outlook.in', 'outlook.pt', 'outlook.be', 'outlook.at',
  'outlook.dk', 'outlook.com.au', 'outlook.com.br', 'outlook.com.tr',
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es',
  'hotmail.be', 'hotmail.nl', 'hotmail.se', 'hotmail.no', 'hotmail.dk',
  'hotmail.fi', 'hotmail.gr', 'hotmail.ch', 'hotmail.ca', 'hotmail.com.au',
  'hotmail.com.br', 'hotmail.com.ar', 'hotmail.com.mx', 'hotmail.com.tr',
  'hotmail.co.jp', 'hotmail.co.th', 'hotmail.co.nz',
  'live.co.uk', 'live.fr', 'live.de', 'live.it', 'live.nl', 'live.se',
  'live.no', 'live.dk', 'live.ca', 'live.ie', 'live.at', 'live.be',
  'live.in', 'live.cn', 'live.jp', 'live.com.au', 'live.com.mx',
  'live.com.pt', 'live.com.sg',
  // Yahoo
  'yahoo.com', 'ymail.com', 'rocketmail.com',
  'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.co.in', 'yahoo.co.id', 'yahoo.co.nz',
  'yahoo.co.th', 'yahoo.ca', 'yahoo.de', 'yahoo.fr', 'yahoo.es', 'yahoo.it',
  'yahoo.se', 'yahoo.dk', 'yahoo.no', 'yahoo.fi', 'yahoo.nl', 'yahoo.be',
  'yahoo.at', 'yahoo.ch', 'yahoo.gr', 'yahoo.pl', 'yahoo.cz', 'yahoo.hu',
  'yahoo.ro', 'yahoo.pt', 'yahoo.ie', 'yahoo.in', 'yahoo.com.au',
  'yahoo.com.br', 'yahoo.com.mx', 'yahoo.com.ar', 'yahoo.com.co',
  'yahoo.com.ph', 'yahoo.com.sg', 'yahoo.com.hk', 'yahoo.com.tw',
  'yahoo.com.tr', 'yahoo.com.vn', 'yahoo.com.my',
  // Apple — including the Sign in with Apple relay. See the note above.
  'icloud.com', 'me.com', 'mac.com', 'privaterelay.appleid.com',
  // AOL
  'aol.com', 'aol.co.uk', 'aim.com',
  // Proton
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  // Zoho
  'zoho.com', 'zohomail.com', 'zoho.eu',
  // GMX / United Internet / Mail.com
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.co.uk',
  'gmx.fr', 'gmx.es', 'web.de', 'mail.com', 'email.com',
  // Yandex and Mail.ru
  'yandex.com', 'yandex.ru', 'yandex.by', 'yandex.kz', 'ya.ru',
  'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'internet.ru',
  // Privacy-first providers with PERMANENT mailboxes — not temp-mail, and a
  // guest who reaches for one still gets a real inbox the OTP lands in.
  'tutanota.com', 'tuta.io', 'tuta.com', 'fastmail.com', 'fastmail.fm',
  'hushmail.com', 'posteo.de', 'mailbox.org', 'runbox.com',
  // Egyptian ISPs
  'link.net', 'tedata.net.eg', 'orange.eg', 'vodafone.com.eg', 'etisalat.eg',
  // Gulf ISPs — a large share of our Egyptian guests live and work there
  'emirates.net.ae', 'eim.ae', 'stc.com.sa', 'qatar.net.qa',
  'batelco.com.bh', 'omantel.net.om',
  // Large non-Western providers seen on inbound international bookings
  'qq.com', '163.com', '126.com', 'sina.com', 'foxmail.com',
  'naver.com', 'daum.net', 'rediffmail.com',
  // Western ISPs still in daily use
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net',
  't-online.de', 'freenet.de', 'libero.it', 'virgilio.it', 'tiscali.it',
  'seznam.cz', 'wp.pl', 'onet.pl', 'interia.pl', 'o2.pl',
  'sapo.pt', 'terra.com.br', 'uol.com.br', 'bol.com.br',
  'telenet.be', 'skynet.be', 'ziggo.nl', 'xs4all.nl', 'telia.com',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net',
  'cox.net', 'charter.net', 'btinternet.com', 'sky.com', 'virginmedia.com',
  'talktalk.net', 'shaw.ca', 'rogers.com', 'bigpond.com', 'optusnet.com.au',
])

/** How many providers the allowlist fast-paths. Exposed for the drift test. */
export const TRUSTED_DOMAIN_COUNT = TRUSTED_DOMAINS.size

/** True when [domain] is a mailbox provider we accept without further checks. */
export function isTrustedEmailDomain(domain: unknown): boolean {
  const d = String(domain ?? '').trim().toLowerCase().replace(/\.$/, '')
  return TRUSTED_DOMAINS.has(d)
}

/** True when the domain of [email] is on the trusted-provider allowlist. */
export function isTrustedEmail(email: unknown): boolean {
  return isTrustedEmailDomain(emailDomain(email))
}

// ---- Did-you-mean --------------------------------------------------------
// Suggestions only ever come from these two lists. Searching the whole root zone
// for a near match produces confident nonsense — `con` is one deletion away from
// `cn` (China) just as it is from `com`, and we would suggest whichever we hit
// first. Order matters: the first match at the winning distance is suggested, so
// the mailbox providers Egyptian guests actually use come first.

const POPULAR_DOMAINS = [
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com',
  'live.com', 'msn.com', 'aol.com', 'googlemail.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'yandex.com', 'zoho.com', 'gmx.com',
]

const POPULAR_TLDS = [
  'com', 'net', 'org', 'eg', 'edu', 'gov', 'co', 'io', 'me', 'info', 'biz',
  'app', 'dev', 'ae', 'sa', 'uk', 'de', 'fr', 'es', 'it', 'nl',
]

/**
 * Edit distance counting a transposition as one edit (optimal string alignment),
 * abandoned once it exceeds [cap]. Transpositions have to be cheap: `gmial.com`
 * is the single most common way to misspell `gmail.com`, and plain Levenshtein
 * charges it two.
 */
function distance(a: string, b: string, cap: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let beforePrev: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, beforePrev[j - 2] + 1)
      }
      row[j] = d
      if (d < best) best = d
    }
    if (best > cap) return cap + 1
    beforePrev = prev
    prev = row
  }
  return prev[b.length]
}

/**
 * Given a domain we have already decided not to accept, the one the guest
 * probably meant — or null when there is no confident guess. It answers
 * "what did they mean?", not "is this wrong?", so a perfectly deliverable but
 * unfamiliar domain can still draw a near-miss guess; only call it once the
 * address has failed validation. `checkEmail` does exactly that.
 */
export function suggestDomain(domain: string): string | null {
  const d = String(domain).trim().toLowerCase().replace(/\.$/, '')
  if (!d || POPULAR_DOMAINS.includes(d)) return null

  // Whole-domain near miss first: `gmail.con` should suggest `gmail.com`, not
  // walk away with a TLD fix that happens to produce the same answer by luck.
  const cap = d.length >= 10 ? 2 : 1
  for (const candidate of POPULAR_DOMAINS) {
    if (distance(d, candidate, cap) <= cap) return candidate
  }

  // Otherwise fix only the extension: `my-company.con` → `my-company.com`.
  const dot = d.lastIndexOf('.')
  if (dot <= 0) return null
  const tld = d.slice(dot + 1)
  if (isKnownTld(tld)) return null
  for (const candidate of POPULAR_TLDS) {
    if (distance(tld, candidate, 1) <= 1) return d.slice(0, dot + 1) + candidate
  }
  return null
}

// ---- Validation ----------------------------------------------------------

export type EmailProblemCode =
  | 'required'
  | 'format'
  | 'tooLong'
  | 'unknownTld'
  | 'disposable'

export type EmailProblem = {
  code: EmailProblemCode
  /** The offending extension, on `unknownTld` only (no leading dot). */
  tld?: string
  /** A better domain to try, when we have a confident guess. */
  suggestion?: string
}

/** Trimmed address with a lowercased domain; the local part keeps its case. */
export function normalizeEmail(email: unknown): string {
  const raw = String(email ?? '').trim()
  const at = raw.lastIndexOf('@')
  if (at < 0) return raw
  return raw.slice(0, at) + '@' + raw.slice(at + 1).toLowerCase()
}

/** The domain of [email], lowercased, or '' when there isn't one. */
export function emailDomain(email: unknown): string {
  const value = normalizeEmail(email)
  const at = value.lastIndexOf('@')
  return at < 0 ? '' : value.slice(at + 1)
}

const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const TLD_SHAPE_RE = /^[a-z]{2,}$|^xn--[a-z0-9-]+$/

/**
 * The first thing wrong with [email], or null when it is worth accepting.
 * Ordered cheapest-first so the message a guest sees names the real problem:
 * a malformed address is a format error, not an unknown extension.
 */
export function checkEmail(email: unknown): EmailProblem | null {
  const value = normalizeEmail(email)
  if (!value) return { code: 'required' }
  if (value.length > MAX_EMAIL_LENGTH) return { code: 'tooLong' }

  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return { code: 'format' }
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)

  if (local.length > MAX_LOCAL_LENGTH || !LOCAL_RE.test(local)) return { code: 'format' }

  const labels = domain.split('.')
  if (labels.length < 2) return { code: 'format' }
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH || !LABEL_RE.test(label)) {
      return { code: 'format' }
    }
  }

  const tld = labels[labels.length - 1]
  if (!TLD_SHAPE_RE.test(tld)) return { code: 'format' }

  // The allowlist fast path: a known mailbox provider is real by definition, so
  // it skips the root-zone lookup and the blocklist walk. Every other domain
  // still has to clear both — that is what lets a company or university address
  // through while temp-mail stays out.
  if (TRUSTED_DOMAINS.has(domain)) return null

  if (!VALID_TLDS.has(tld)) {
    const problem: EmailProblem = { code: 'unknownTld', tld }
    const suggestion = suggestDomain(domain)
    if (suggestion) problem.suggestion = suggestion
    return problem
  }

  if (isDisposableEmail(value)) return { code: 'disposable' }
  return null
}

/** True when [email] is well-formed and its extension is a real TLD. */
export function isValidEmail(email: unknown): boolean {
  const problem = checkEmail(email)
  // Disposable is a policy call, not a malformed address — callers that only
  // want "is this a deliverable shape" (resend-otp) shouldn't trip on it.
  return problem === null || problem.code === 'disposable'
}

export function isDisposableEmail(email: unknown): boolean {
  const domain = emailDomain(email)
  if (!domain) return false
  // Reject if the domain itself OR any parent domain is blocklisted, so a
  // subdomain (e.g. sub.mailinator.com) can't slip past the exact-match check.
  const labels = domain.split('.')
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true
  }
  return false
}

/** English copy for an API response. The web form localizes these itself. */
export function emailProblemMessage(problem: EmailProblem): string {
  switch (problem.code) {
    case 'required':
      return 'Email and password are required'
    case 'tooLong':
      return 'That email address is too long.'
    case 'unknownTld': {
      const head = `“.${problem.tld}” isn't a valid domain extension.`
      return problem.suggestion
        ? `${head} Did you mean @${problem.suggestion}?`
        : `${head} Please check the email address.`
    }
    case 'disposable':
      return 'Temporary or disposable email addresses are not allowed. Please use a permanent personal or work email.'
    default:
      return 'Please enter a valid email address'
  }
}
