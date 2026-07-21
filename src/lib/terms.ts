/* Terms & Conditions content (bilingual), ported verbatim from the vanilla
 * TERMS_DATA (assets/js/app.js). Static, trusted content — the paragraph strings
 * contain simple inline HTML (<b>, <a>) and are rendered via dangerouslySetInnerHTML
 * in Terms.tsx, exactly as the vanilla injected them. */

export type TermsBlock = string | { ol: string[] } | { ul: string[] } | { box: string };
export interface TermsSection { h: string; body: TermsBlock[] }

const CONTACT_EN = `<p>For general questions about these Terms or the Platform: <a href="mailto:contact@groloo.com">contact@groloo.com</a></p>
  <p>For copyright / DMCA takedown notices (designated agent): <a href="mailto:legal@groloo.com">legal@groloo.com</a></p>`;
const CONTACT_KA = `<p>ზოგადი შეკითხვებისთვის ამ პირობებზე ან პლატფორმაზე: <a href="mailto:contact@groloo.com">contact@groloo.com</a></p>
  <p>საავტორო უფლებების / DMCA შეტყობინებებისთვის (დანიშნული აგენტი): <a href="mailto:legal@groloo.com">legal@groloo.com</a></p>`;

export const TERMS_DATA: Record<string, TermsSection[]> = {
  en: [
    { h: `Introduction`, body: [
      `Welcome to Groloo. These Terms &amp; Conditions ("Terms") govern your access to and use of the Groloo website, applications, and related services (together, the "Platform"). By accessing or using the Platform, you agree to be bound by these Terms. If you do not agree, you must not access or use the Platform.`,
      `Groloo is a media catalog and user-interface platform. It provides tools to discover, organise, and play media that is made available by third-party services. Groloo does not host, store, upload, or distribute any media files. Please read these Terms carefully together with our DMCA / Takedown Policy, which is incorporated into these Terms by reference.`,
    ] },
    { h: `Definitions`, body: [
      { ul: [
        `<b>"Platform"</b> — the Groloo website, software, interfaces, and related services.`,
        `<b>"Add-on"</b> — a first-party or third-party software module that supplies catalogs, metadata, subtitles, ratings, or stream links to the Platform.`,
        `<b>"Official Add-on"</b> — an Add-on developed or curated by the Groloo team and shipped with the Platform.`,
        `<b>"Community Add-on"</b> — an Add-on created and maintained independently by third-party developers, which a user may choose to install.`,
        `<b>"Content"</b> — any catalog metadata, artwork, stream link, subtitle, or other material surfaced through the Platform or an Add-on.`,
        `<b>"Third-Party Service"</b> — any external website, server, or service that actually hosts or transmits Content.`,
        `<b>"User", "you"</b> — any person who accesses or uses the Platform.`,
      ] },
    ] },
    { h: `Use of the Platform`, body: [
      `The Platform operates solely as a media catalog and user interface. It indexes descriptive information (titles, artwork, ratings, and metadata) and provides a unified interface for discovering and playing media supplied by Third-Party Services and Add-ons.`,
      `Groloo does not store, host, upload, cache, or distribute any media content. All playable media is provided by, and hosted on, independent Third-Party Services that are outside our control.`,
      `You may use the Platform only for lawful, personal, non-commercial purposes, in compliance with these Terms and all applicable laws. Certain features may require you to create an account; you are responsible for safeguarding your credentials and for all activity under your account.`,
      `We may modify, suspend, or discontinue any part of the Platform at any time, with or without notice.`,
    ] },
    { h: `Eligibility`, body: [
      `You must be at least 18 years old, or the age of legal majority in your jurisdiction, to create an account or use the Platform. By using the Platform you represent and warrant that you meet this requirement and have the legal capacity to enter into these Terms. The Platform is not directed to children, and we do not knowingly collect personal data from anyone under the age of majority.`,
    ] },
    { h: `The Add-on Ecosystem`, body: [
      `The Platform provides an open framework that allows Users to install Add-ons. Add-ons extend the Platform with catalogs, metadata, subtitles, ratings, and stream sources.`,
      `<b>Community Add-ons are created, published, and maintained independently by third-party community developers. They are not developed, maintained, controlled, or endorsed by Groloo or its team.</b> Groloo provides the framework only; we do not select, review, monitor, or control what any Community Add-on accesses, indexes, links to, or makes available.`,
      `Installing a Community Add-on is done entirely at the User's own discretion and risk. Groloo has no control over, and accepts no responsibility for, the Content, availability, legality, accuracy, or behaviour of any Community Add-on or of the Third-Party Services it connects to.`,
      `By default, no Community streaming Add-on is installed, and the Platform functions purely as a media catalog and user interface. Stream sources become available only after a User chooses to install and configure a Community Add-on.`,
      `Copyright holders who wish to report allegedly infringing material accessed through a Community Add-on must contact the individual Add-on developer or the Third-Party Service that hosts the material, and not Groloo. See the "DMCA &amp; Copyright" section below.`,
    ] },
    { h: `User Obligations`, body: [
      `You are solely responsible for the Add-ons you choose to install and for any Content you access, stream, or download through them. You must comply with all copyright, intellectual-property, and other laws applicable in your jurisdiction.`,
      `You agree not to: (a) use the Platform for any unlawful purpose; (b) use the Platform or any Add-on to access, reproduce, or distribute material you are not legally entitled to access; (c) circumvent or disable any security or access-control feature; (d) interfere with or disrupt the Platform or its infrastructure; or (e) infringe the rights of any third party.`,
      `Installing and using Community Add-ons is done at your own risk. You accept full responsibility for ensuring that your use of any Add-on is lawful in your jurisdiction.`,
    ] },
    { h: `Intellectual Property`, body: [
      `The Platform — including its software, design, interface, trademarks, logos, and original content — is owned by Groloo or its licensors and is protected by applicable intellectual-property laws. Except as expressly permitted, you may not copy, modify, distribute, or create derivative works from the Platform.`,
      `Catalog metadata and artwork displayed on the Platform are descriptive information provided for identification and discovery purposes and remain the property of their respective owners. They are not the copyrighted media files themselves.`,
      `Add-ons and the Content they supply are the property of their respective developers and rights holders. Nothing in these Terms grants you any right in third-party intellectual property.`,
    ] },
    { h: `DMCA &amp; Copyright`, body: [
      `Groloo respects the intellectual-property rights of others and expects its Users to do the same. Because Groloo does not host, store, or transmit any media files, infringing media is not located on our servers.`,
      `If you believe that descriptive metadata or a link presented by an Official Groloo component infringes your copyright, you may send a takedown notice to our designated agent at <a href="mailto:legal@groloo.com">legal@groloo.com</a>. We will respond to valid notices and will promptly disable or remove the offending material that is within our control.`,
      `For Content accessed through a Community Add-on or a Third-Party Service, the material is hosted by, and under the control of, that Add-on developer or service — not Groloo. Takedown notices for such material must be directed to the relevant Add-on developer or the Third-Party Service that actually hosts the file. Removing a link or metadata entry from our index does not, and cannot, delete a file stored on a third-party server.`,
      `A valid takedown notice should include:`,
      { ol: [
        `Identification of the copyrighted work you claim has been infringed.`,
        `Identification of the specific material and its exact location on the Platform.`,
        `Your contact details (name, organisation, email, and physical address).`,
        `A statement that you have a good-faith belief the use is not authorised by the rights holder, its agent, or the law.`,
        `A statement, under penalty of perjury, that the information in your notice is accurate and that you are the rights holder or are authorised to act on its behalf.`,
        `Your physical or electronic signature.`,
      ] },
      `<b>Counter-notification.</b> If you believe that material we removed or disabled was removed as a result of mistake or misidentification, you may send a counter-notification to our designated agent at <a href="mailto:legal@groloo.com">legal@groloo.com</a>, including: (a) identification of the removed material and the location where it appeared before removal; (b) your name, address, telephone number, and email; (c) a statement, under penalty of perjury, that you have a good-faith belief the material was removed or disabled by mistake or misidentification; (d) your consent to the jurisdiction of the courts identified in the "Governing Law" section and to accept service of process from the party that filed the original notice; and (e) your physical or electronic signature.`,
      `<b>Repeat infringers.</b> In appropriate circumstances, and at our sole discretion, we will disable or terminate the accounts of Users who are determined to be repeat infringers.`,
    ] },
    { h: `Disclaimer of Warranties`, body: [
      `The Platform is provided "as is" and "as available", without warranties of any kind, whether express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, title, and non-infringement.`,
      `Groloo makes no warranty that the Platform will be uninterrupted, secure, or error-free, or that any Content available through Add-ons or Third-Party Services will be available, accurate, complete, lawful, or of any particular quality. Groloo does not endorse and is not responsible for any Content, Add-on, or Third-Party Service, and any reliance you place on such material is strictly at your own risk.`,
    ] },
    { h: `Limitation of Liability`, body: [
      `To the maximum extent permitted by applicable law, Groloo and its operators, affiliates, and contributors shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of data, profits, or goodwill, arising out of or in connection with your use of (or inability to use) the Platform, any Add-on, or any Third-Party Service.`,
      `Groloo is not responsible for the behaviour, Content, or legality of any third-party Add-on or Third-Party Service, nor for any action a User takes in reliance on them. Nothing in these Terms excludes or limits any liability that cannot be excluded or limited under applicable law.`,
    ] },
    { h: `Indemnification`, body: [
      `You agree to indemnify, defend, and hold harmless Groloo and its operators, affiliates, and contributors from and against any claims, demands, liabilities, damages, losses, costs, and expenses (including reasonable legal fees) arising out of or related to: (a) your use or misuse of the Platform; (b) any Add-on you install, configure, or use, or any Third-Party Service you reach through it; (c) Content you access, stream, download, or share; (d) your violation of these Terms or of any applicable law; or (e) your infringement of any intellectual-property or other right of any person or entity.`,
    ] },
    { h: `Governing Law`, body: [
      `These Terms are governed by and construed in accordance with the laws of Georgia, without regard to its conflict-of-laws provisions. You agree to submit to the exclusive jurisdiction of the competent courts of Georgia for the resolution of any dispute arising out of or relating to these Terms or the Platform.`,
    ] },
    { h: `Changes to Terms`, body: [
      `We may update these Terms from time to time. When we do, we will revise the "Last updated" date shown above, and material changes may be communicated through the Platform. Your continued use of the Platform after changes take effect constitutes acceptance of the revised Terms. If you do not agree to the changes, you must stop using the Platform.`,
    ] },
    { h: `General`, body: [
      `If any provision of these Terms is held invalid or unenforceable, that provision will be limited or severed to the minimum extent necessary and the remaining provisions will remain in full force and effect. Our failure to enforce any provision is not a waiver of it. You may not assign these Terms without our prior consent; we may assign them to a successor or affiliate. These Terms, together with the DMCA / Takedown Policy, are the entire agreement between you and Groloo regarding the Platform and supersede any prior understanding.`,
    ] },
    { h: `Contact Information`, body: [
      `Questions about these Terms, or notices required under them, may be sent to the addresses below:`,
      { box: CONTACT_EN },
    ] },
  ],
  ka: [
    { h: `შესავალი`, body: [
      `მოგესალმებით Groloo-ში. ეს წესები და პირობები ("პირობები") არეგულირებს თქვენს წვდომას და გამოყენებას Groloo-ის ვებსაიტზე, აპლიკაციებსა და დაკავშირებულ სერვისებზე (ერთობლივად — "პლატფორმა"). პლატფორმაზე წვდომით ან მისი გამოყენებით თქვენ ეთანხმებით ამ პირობებს. თუ არ ეთანხმებით, არ უნდა ისარგებლოთ პლატფორმით.`,
      `Groloo არის მედია კატალოგისა და მომხმარებლის ინტერფეისის პლატფორმა. ის გთავაზობთ ხელსაწყოებს მესამე მხარის სერვისების მიერ ხელმისაწვდომი მედიის აღმოსაჩენად, დასალაგებლად და დასაკრავად. Groloo არ მასპინძლობს, არ ინახავს, არ ტვირთავს და არ ავრცელებს არცერთ მედია ფაილს. გთხოვთ, ყურადღებით წაიკითხოთ ეს პირობები ჩვენს DMCA / წაშლის პოლიტიკასთან ერთად, რომელიც ამ პირობების განუყოფელი ნაწილია.`,
    ] },
    { h: `განმარტებები`, body: [
      { ul: [
        `<b>"პლატფორმა"</b> — Groloo-ის ვებსაიტი, პროგრამული უზრუნველყოფა, ინტერფეისები და დაკავშირებული სერვისები.`,
        `<b>"დამატება" (Add-on)</b> — პირველი ან მესამე მხარის პროგრამული მოდული, რომელიც პლატფორმას აწვდის კატალოგებს, მეტამონაცემებს, სუბტიტრებს, შეფასებებს ან სტრიმების ბმულებს.`,
        `<b>"ოფიციალური დამატება"</b> — დამატება, რომელიც შემუშავებული ან შერჩეულია Groloo-ის გუნდის მიერ და მოყვება პლატფორმას.`,
        `<b>"საზოგადოების დამატება"</b> — დამატება, რომელიც დამოუკიდებლად არის შექმნილი და მხარდაჭერილი მესამე მხარის შემქმნელების მიერ და რომლის ინსტალაციაც მომხმარებელს შეუძლია საკუთარი შეხედულებისამებრ.`,
        `<b>"კონტენტი"</b> — ნებისმიერი კატალოგის მეტამონაცემი, საფარის გრაფიკა, სტრიმის ბმული, სუბტიტრი ან სხვა მასალა, რომელიც ჩანს პლატფორმაზე ან დამატების მეშვეობით.`,
        `<b>"მესამე მხარის სერვისი"</b> — ნებისმიერი გარე ვებსაიტი, სერვერი ან სერვისი, რომელიც რეალურად მასპინძლობს ან გადასცემს კონტენტს.`,
        `<b>"მომხმარებელი", "თქვენ"</b> — ნებისმიერი პირი, რომელიც წვდება ან იყენებს პლატფორმას.`,
      ] },
    ] },
    { h: `პლატფორმის გამოყენება`, body: [
      `პლატფორმა მუშაობს მხოლოდ როგორც მედია კატალოგი და მომხმარებლის ინტერფეისი. ის ახდენს აღწერითი ინფორმაციის ინდექსირებას (სათაურები, გრაფიკა, შეფასებები და მეტამონაცემები) და გთავაზობთ ერთიან ინტერფეისს მესამე მხარის სერვისებისა და დამატებების მიერ მოწოდებული მედიის აღმოსაჩენად და დასაკრავად.`,
      `Groloo არ ინახავს, არ მასპინძლობს, არ ტვირთავს, არ ქეშავს და არ ავრცელებს არცერთ მედია კონტენტს. ყველა დასაკრავი მედია მოწოდებულია და განთავსებულია დამოუკიდებელ მესამე მხარის სერვისებზე, რომლებიც ჩვენი კონტროლის მიღმაა.`,
      `პლატფორმის გამოყენება შეგიძლიათ მხოლოდ კანონიერი, პირადი, არაკომერციული მიზნებისთვის, ამ პირობებისა და ყველა მოქმედი კანონის დაცვით. ზოგიერთ ფუნქციას შესაძლოა ანგარიშის შექმნა დასჭირდეს; თქვენ პასუხისმგებელი ხართ თქვენი მონაცემების დაცვაზე და თქვენი ანგარიშით განხორციელებულ ყველა ქმედებაზე.`,
      `ჩვენ შეგვიძლია ნებისმიერ დროს შევცვალოთ, შევაჩეროთ ან შევწყვიტოთ პლატფორმის ნებისმიერი ნაწილი, წინასწარი შეტყობინებით ან მის გარეშე.`,
    ] },
    { h: `უფლებამოსილება (ასაკი)`, body: [
      `პლატფორმის გამოსაყენებლად ან ანგარიშის შესაქმნელად უნდა იყოთ სულ მცირე 18 წლის, ან თქვენი იურისდიქციის სრულწლოვანების ასაკის. პლატფორმის გამოყენებით თქვენ აცხადებთ და იძლევით გარანტიას, რომ აკმაყოფილებთ ამ მოთხოვნას და გაქვთ ამ პირობების დადების სამართლებრივი ქმედუნარიანობა. პლატფორმა არ არის გათვლილი ბავშვებზე და ჩვენ შეგნებულად არ ვაგროვებთ პერსონალურ მონაცემებს სრულწლოვანების ასაკს მიუღწეველ პირებზე.`,
    ] },
    { h: `დამატებების ეკოსისტემა`, body: [
      `პლატფორმა გთავაზობთ ღია ჩარჩოს, რომელიც მომხმარებლებს დამატებების ინსტალაციის საშუალებას აძლევს. დამატებები აფართოებს პლატფორმას კატალოგებით, მეტამონაცემებით, სუბტიტრებით, შეფასებებითა და სტრიმის წყაროებით.`,
      `<b>საზოგადოების დამატებები იქმნება, ქვეყნდება და მხარდაჭერილია დამოუკიდებლად მესამე მხარის შემქმნელების მიერ. ისინი არ არის შემუშავებული, მხარდაჭერილი, კონტროლირებადი ან მოწონებული Groloo-ის ან მისი გუნდის მიერ.</b> Groloo უზრუნველყოფს მხოლოდ ჩარჩოს; ჩვენ არ ვარჩევთ, არ ვამოწმებთ, არ ვაკონტროლებთ იმას, რასაც საზოგადოების დამატება წვდება, ინდექსირებს, აკავშირებს ან ხელმისაწვდომს ხდის.`,
      `საზოგადოების დამატების ინსტალაცია მთლიანად მომხმარებლის შეხედულებითა და რისკით ხდება. Groloo-ს არ აქვს კონტროლი და არ იღებს პასუხისმგებლობას ნებისმიერი საზოგადოების დამატების ან მისი დაკავშირებული მესამე მხარის სერვისების კონტენტზე, ხელმისაწვდომობაზე, კანონიერებაზე, სიზუსტესა თუ ქცევაზე.`,
      `ნაგულისხმევად, არცერთი საზოგადოების სტრიმინგ-დამატება არ არის დაინსტალირებული და პლატფორმა მუშაობს მხოლოდ როგორც მედია კატალოგი და მომხმარებლის ინტერფეისი. სტრიმის წყაროები ხელმისაწვდომი ხდება მხოლოდ მას შემდეგ, რაც მომხმარებელი თავად აირჩევს საზოგადოების დამატების ინსტალაციასა და კონფიგურაციას.`,
      `საავტორო უფლებების მფლობელებმა, რომელთაც სურთ საზოგადოების დამატების მეშვეობით ხელმისაწვდომი სავარაუდოდ დარღვევითი მასალის შესახებ შეტყობინება, უნდა დაუკავშირდნენ კონკრეტული დამატების შემქმნელს ან მესამე მხარის სერვისს, რომელიც მასპინძლობს მასალას — და არა Groloo-ს. იხილეთ ქვემოთ "DMCA და საავტორო უფლებები".`,
    ] },
    { h: `მომხმარებლის ვალდებულებები`, body: [
      `თქვენ ხართ ერთპიროვნულად პასუხისმგებელი იმ დამატებებზე, რომელთა ინსტალაციასაც ირჩევთ, და ნებისმიერ კონტენტზე, რომელსაც მათი მეშვეობით წვდებით, უყურებთ ან ჩამოტვირთავთ. თქვენ უნდა დაიცვათ საავტორო, ინტელექტუალური საკუთრებისა და სხვა კანონები, რომლებიც მოქმედებს თქვენს იურისდიქციაში.`,
      `თქვენ თანხმდებით, რომ არ: (ა) გამოიყენებთ პლატფორმას რაიმე უკანონო მიზნით; (ბ) გამოიყენებთ პლატფორმას ან დამატებას ისეთ მასალაზე წვდომისთვის, რეპროდუცირებისთვის ან გასავრცელებლად, რომელზეც კანონიერი უფლება არ გაქვთ; (გ) გვერდს აუვლით ან გათიშავთ უსაფრთხოების ან წვდომის კონტროლის ფუნქციებს; (დ) ხელს შეუშლით ან დაარღვევთ პლატფორმის ან მისი ინფრასტრუქტურის მუშაობას; ან (ე) დაარღვევთ მესამე მხარის უფლებებს.`,
      `საზოგადოების დამატებების ინსტალაცია და გამოყენება თქვენი საკუთარი რისკით ხდება. თქვენ იღებთ სრულ პასუხისმგებლობას იმის უზრუნველსაყოფად, რომ ნებისმიერი დამატების გამოყენება თქვენს იურისდიქციაში კანონიერია.`,
    ] },
    { h: `ინტელექტუალური საკუთრება`, body: [
      `პლატფორმა — მისი პროგრამული უზრუნველყოფის, დიზაინის, ინტერფეისის, სავაჭრო ნიშნების, ლოგოებისა და ორიგინალური კონტენტის ჩათვლით — ეკუთვნის Groloo-ს ან მის ლიცენზიარებს და დაცულია მოქმედი ინტელექტუალური საკუთრების კანონებით. გარდა იმ შემთხვევებისა, როცა ეს პირდაპირ ნებადართულია, თქვენ არ შეგიძლიათ პლატფორმის კოპირება, შეცვლა, გავრცელება ან მისგან წარმოებული ნამუშევრების შექმნა.`,
      `პლატფორმაზე ნაჩვენები კატალოგის მეტამონაცემები და გრაფიკა არის აღწერითი ინფორმაცია იდენტიფიკაციისა და აღმოჩენის მიზნებისთვის და რჩება მათი შესაბამისი მფლობელების საკუთრებად. ისინი არ წარმოადგენს თავად საავტორო უფლებებით დაცულ მედია ფაილებს.`,
      `დამატებები და მათ მიერ მოწოდებული კონტენტი მათი შესაბამისი შემქმნელებისა და უფლების მფლობელების საკუთრებაა. ამ პირობებში არაფერი განიჭებთ უფლებას მესამე მხარის ინტელექტუალურ საკუთრებაზე.`,
    ] },
    { h: `DMCA და საავტორო უფლებები`, body: [
      `Groloo პატივს სცემს სხვების ინტელექტუალური საკუთრების უფლებებს და იგივეს მოელის თავისი მომხმარებლებისგან. რადგან Groloo არ მასპინძლობს, არ ინახავს და არ გადასცემს არცერთ მედია ფაილს, დარღვევითი მედია ჩვენს სერვერებზე არ მდებარეობს.`,
      `თუ თვლით, რომ Groloo-ის ოფიციალური კომპონენტის მიერ წარმოდგენილი აღწერითი მეტამონაცემი ან ბმული არღვევს თქვენს საავტორო უფლებას, შეგიძლიათ გამოაგზავნოთ წაშლის შეტყობინება ჩვენს დანიშნულ აგენტთან: <a href="mailto:legal@groloo.com">legal@groloo.com</a>. ჩვენ ვუპასუხებთ ვალიდურ შეტყობინებებს და დაუყოვნებლივ გავთიშავთ ან წავშლით დარღვევით მასალას, რომელიც ჩვენი კონტროლის ფარგლებშია.`,
      `საზოგადოების დამატების ან მესამე მხარის სერვისის მეშვეობით ხელმისაწვდომი კონტენტი განთავსებულია და კონტროლდება ამ დამატების შემქმნელის ან სერვისის მიერ — და არა Groloo-ის. ასეთი მასალის წაშლის შეტყობინებები უნდა გაიგზავნოს შესაბამისი დამატების შემქმნელთან ან მესამე მხარის სერვისთან, რომელიც რეალურად მასპინძლობს ფაილს. ჩვენი ინდექსიდან ბმულის ან მეტამონაცემის წაშლა არ შლის და ვერ წაშლის მესამე მხარის სერვერზე განთავსებულ ფაილს.`,
      `ვალიდური წაშლის შეტყობინება უნდა შეიცავდეს:`,
      { ol: [
        `იმ საავტორო ნაწარმოების იდენტიფიკაცია, რომელიც, თქვენი აზრით, დაირღვა.`,
        `კონკრეტული მასალისა და მისი ზუსტი მდებარეობის იდენტიფიკაცია პლატფორმაზე.`,
        `თქვენი საკონტაქტო მონაცემები (სახელი, ორგანიზაცია, ელფოსტა და ფიზიკური მისამართი).`,
        `განცხადება, რომ კეთილსინდისიერად მიგაჩნიათ, რომ გამოყენება არ არის ნებადართული უფლების მფლობელის, მისი აგენტის ან კანონის მიერ.`,
        `განცხადება, ცრუ ჩვენების პასუხისმგებლობის ქვეშ, რომ შეტყობინებაში მოცემული ინფორმაცია ზუსტია და რომ თქვენ ხართ უფლების მფლობელი ან უფლებამოსილი მის სახელით მოქმედებაზე.`,
        `თქვენი ფიზიკური ან ელექტრონული ხელმოწერა.`,
      ] },
      `<b>საპასუხო შეტყობინება.</b> თუ თვლით, რომ ჩვენ მიერ წაშლილი ან გათიშული მასალა მოიხსნა შეცდომის ან არასწორი იდენტიფიკაციის გამო, შეგიძლიათ გამოაგზავნოთ საპასუხო შეტყობინება ჩვენს დანიშნულ აგენტთან მისამართზე <a href="mailto:legal@groloo.com">legal@groloo.com</a>, რომელიც მოიცავს: (ა) წაშლილი მასალის იდენტიფიკაციას და მის ადგილმდებარეობას წაშლამდე; (ბ) თქვენს სახელს, მისამართს, ტელეფონის ნომერსა და ელფოსტას; (გ) განცხადებას, ცრუ ჩვენების პასუხისმგებლობის ქვეშ, რომ კეთილსინდისიერად მიგაჩნიათ, რომ მასალა წაიშალა ან გაითიშა შეცდომით ან არასწორი იდენტიფიკაციით; (დ) თქვენს თანხმობას „მარეგულირებელი კანონმდებლობის“ სექციაში მითითებული სასამართლოების იურისდიქციაზე და თავდაპირველი შეტყობინების ავტორისგან საპროცესო დოკუმენტების მიღებაზე; და (ე) თქვენს ფიზიკურ ან ელექტრონულ ხელმოწერას.`,
      `<b>განმეორებითი დამრღვევები.</b> შესაბამის შემთხვევებში და ჩვენი შეხედულებისამებრ, ჩვენ გავთიშავთ ან დავხურავთ იმ მომხმარებლების ანგარიშებს, რომლებიც დადგინდება როგორც განმეორებითი დამრღვევები.`,
    ] },
    { h: `გარანტიების უარყოფა`, body: [
      `პლატფორმა მოწოდებულია "როგორც არის" და "როგორც ხელმისაწვდომია", ნებისმიერი სახის გარანტიის გარეშე, იქნება ეს პირდაპირი თუ ნაგულისხმევი, მათ შორის — ვაჭრობისთვის ვარგისიანობის, კონკრეტული მიზნისთვის შესაბამისობის, საკუთრებისა და უფლების დაურღვევლობის ნაგულისხმევი გარანტიების ჩათვლით.`,
      `Groloo არ იძლევა გარანტიას, რომ პლატფორმა იქნება უწყვეტი, უსაფრთხო ან შეცდომების გარეშე, ან რომ დამატებებისა და მესამე მხარის სერვისების მეშვეობით ხელმისაწვდომი კონტენტი იქნება ხელმისაწვდომი, ზუსტი, სრული, კანონიერი ან რაიმე კონკრეტული ხარისხის. Groloo არ მოიწონებს და არ არის პასუხისმგებელი არცერთ კონტენტზე, დამატებაზე ან მესამე მხარის სერვისზე, და ასეთ მასალაზე დაყრდნობა მთლიანად თქვენი რისკით ხდება.`,
    ] },
    { h: `პასუხისმგებლობის შეზღუდვა`, body: [
      `მოქმედი კანონით დაშვებული მაქსიმალური ფარგლებში, Groloo და მისი ოპერატორები, აფილირებული პირები და კონტრიბუტორები არ იქნებიან პასუხისმგებელი რაიმე არაპირდაპირ, შემთხვევით, სპეციალურ, თანმდევ ან სადამსჯელო ზიანზე, ან მონაცემების, მოგების თუ რეპუტაციის დაკარგვაზე, რომელიც წარმოიშობა პლატფორმის, ნებისმიერი დამატების ან მესამე მხარის სერვისის გამოყენებასთან (ან გამოყენების შეუძლებლობასთან) დაკავშირებით.`,
      `Groloo არ არის პასუხისმგებელი ნებისმიერი მესამე მხარის დამატების ან სერვისის ქცევაზე, კონტენტზე ან კანონიერებაზე, ისევე როგორც მომხმარებლის ნებისმიერ ქმედებაზე, რომელიც მათზე დაყრდნობით ხდება. ამ პირობებში არაფერი გამორიცხავს ან ზღუდავს იმ პასუხისმგებლობას, რომელიც მოქმედი კანონით ვერ გამოირიცხება ან შეიზღუდება.`,
    ] },
    { h: `ზიანის ანაზღაურება (ინდემნიფიკაცია)`, body: [
      `თქვენ თანხმდებით, რომ აანაზღაურებთ, დაიცავთ და გაათავისუფლებთ Groloo-ს და მის ოპერატორებს, აფილირებულ პირებსა და კონტრიბუტორებს ნებისმიერი პრეტენზიის, მოთხოვნის, ვალდებულების, ზიანის, დანაკარგის, ხარჯისა და დანახარჯისგან (გონივრული იურიდიული ხარჯების ჩათვლით), რომელიც წარმოიშობა ან დაკავშირებულია: (ა) თქვენ მიერ პლატფორმის გამოყენებასთან ან არასათანადო გამოყენებასთან; (ბ) ნებისმიერ დამატებასთან, რომელსაც აინსტალირებთ, აკონფიგურირებთ ან იყენებთ, ან მესამე მხარის სერვისთან, რომელსაც მისი მეშვეობით წვდებით; (გ) კონტენტთან, რომელსაც წვდებით, უყურებთ, ჩამოტვირთავთ ან აზიარებთ; (დ) ამ პირობების ან ნებისმიერი მოქმედი კანონის დარღვევასთან; ან (ე) ნებისმიერი პირის ან ორგანიზაციის ინტელექტუალური საკუთრების ან სხვა უფლების დარღვევასთან.`,
    ] },
    { h: `მარეგულირებელი კანონმდებლობა`, body: [
      `ეს პირობები რეგულირდება და განიმარტება საქართველოს კანონმდებლობის შესაბამისად, კანონთა კოლიზიის ნორმების გათვალისწინების გარეშე. თქვენ თანხმდებით, რომ ამ პირობებთან ან პლატფორმასთან დაკავშირებული ნებისმიერი დავის გადასაჭრელად დაემორჩილებით საქართველოს კომპეტენტური სასამართლოების ექსკლუზიურ იურისდიქციას.`,
    ] },
    { h: `პირობების ცვლილებები`, body: [
      `ჩვენ შესაძლოა დროდადრო განვაახლოთ ეს პირობები. ამ შემთხვევაში განვაახლებთ ზემოთ მითითებულ "ბოლო განახლების" თარიღს, ხოლო არსებითი ცვლილებები შესაძლოა გამოცხადდეს პლატფორმის მეშვეობით. ცვლილებების ძალაში შესვლის შემდეგ პლატფორმის გამოყენების გაგრძელება ნიშნავს განახლებული პირობების მიღებას. თუ არ ეთანხმებით ცვლილებებს, უნდა შეწყვიტოთ პლატფორმის გამოყენება.`,
    ] },
    { h: `ზოგადი დებულებები`, body: [
      `თუ ამ პირობების რომელიმე დებულება ბათილად ან აღუსრულებლად იქნა მიჩნეული, ეს დებულება შეიზღუდება ან გამოეყოფა მინიმალური აუცილებელი ფარგლებით, ხოლო დანარჩენი დებულებები სრულად შენარჩუნდება ძალაში. ჩვენ მიერ რომელიმე დებულების აღუსრულებლობა არ ნიშნავს მასზე უარის თქმას. თქვენ არ შეგიძლიათ ამ პირობების გადაცემა ჩვენი წინასწარი თანხმობის გარეშე; ჩვენ შეგვიძლია მათი გადაცემა უფლებამონაცვლეზე ან აფილირებულ პირზე. ეს პირობები, DMCA / წაშლის პოლიტიკასთან ერთად, წარმოადგენს სრულ შეთანხმებას თქვენსა და Groloo-ს შორის პლატფორმასთან დაკავშირებით და ანაცვლებს ნებისმიერ წინა შეთანხმებას.`,
    ] },
    { h: `საკონტაქტო ინფორმაცია`, body: [
      `კითხვები ამ პირობებზე, ან მათ ფარგლებში მოთხოვნილი შეტყობინებები, შეგიძლიათ გამოაგზავნოთ ქვემოთ მითითებულ მისამართებზე:`,
      { box: CONTACT_KA },
    ] },
  ],
};
