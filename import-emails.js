// Email Import Script — Acorn PMS
// Place in acorn-pms-clean\ folder and run: node import-emails.js
// Server does NOT need to be running. Stop it first, run this, then restart.

'use strict';
const path = require('path');
process.chdir(__dirname);

async function run() {
  // Load database the same way the server does
  const db = require('./db/database');
  await db.init();

  // Add email column if it doesn't exist yet
  try {
    db.prepare('ALTER TABLE users ADD COLUMN email TEXT').run();
    console.log('  Added email column to users table');
  } catch(e) {
    // Column already exists — that's fine
    console.log('  email column already exists, continuing...');
  }

  const updates = [
    [20258, 'jasim@travelservices.mv'],  // Jasim Uddin
    [20232, 'commonusers@acorn.lk'],  // Deloar Hossain
    [20288, 'mredul@travelservices.mv'],  // Mredul Biswas
    [20444, 'karthikeyan@goindigo.in'],  // Karthikeyan Chandrasekaran
    [20217, 'commonusers@acorn.lk'],  // Hussain Didi
    [20452, 'dutymgr@aviationservices.mv'],  // Mohamed Hameed
    [20447, 'commonusers@acorn.lk'],  // Ahmed  Ahsan
    [20462, 'commonusers@acorn.lk'],  // Hassan  Aleef
    [20302, 'commonusers@acorn.lk'],  // Ahmed  Husham
    [20221, 'commonusers@acorn.lk'],  // Ugail Yoosuf
    [20223, 'commonusers@acorn.lk'],  // Ali Thorif
    [7575, 'shareek.r@mv.dth.travel'],  // Shareek Rasheed
    [20220, 'admin_officer@mv.dth.travel'],  // Aminath Vishama
    [20268, 'corporate1@aviationservices.mv'],  // Maryam Ahmed
    [20332, 'commonusers@acorn.lk'],  // Aishath Raaha Mohamed
    [20215, 'howard@aviationservices.mv'],  // Howard Brohier
    [20183, 'ma-aal@travelservices.mv'],  // Ma-aal Ali
    [20456, 'commonusers@acorn.lk'],  // Maisha Mannan
    [20229, 'operations@dertourgroup-maldives.com'],  // Aishath Jumaana
    [20230, 'der@dertourgroup-maldives.com'],  // Mariyam Latheef
    [20219, 'commonusers@acorn.lk'],  // Mohamed Manik
    [20168, 'suha@travelservices.mv'],  // Mariyam Suha
    [20169, 'indigo@aviationservices.mv'],  // Thasleema Ahmed
    [20239, 'miushanshamoon@gmail.com'],  // Aminath Shamoon
    [20186, 'ali.habeeb@goindigo.in'],  // Azhan Habeeb
    [20453, 'dutysup@aviationservices.mv'],  // Zaina Nazeer
    [20218, 'mohamed.n@mv.dth.travel'],  // Mohamed Nishath
    [20289, 'shazeen@travelservices.mv'],  // Shazeen Zawahir
    [20216, 'lalith.o@mv.dth.travel'],  // Lalith Olagama
    [20356, 'milan.finance@acorn.lk'],  // Milan Thiwanka
    [20157, 'fayas.h@lk.dth.travel'],  // A H M Fayas
    [3722, 'fiona.travels@acorn.lk'],  // Fiona Ziegelaar
    [1240, 'ramada@lk.dth.travel'],  // Ajantha Weerasinghe
    [12084, 'insaf.m@lk.dth.travel'],  // Insaf Mohamed
    [10122, 'menik.p@lk.dth.travel'],  // Menik Paranawithana
    [4266, 'gowrie.travels@acorn.lk'],  // Gowrie Fernando
    [9460, 'shamara.travels@acorn.lk'],  // Shamara Fernando
    [20285, 'procurement-1@lk.dth.travel'],  // Samira Sappideen
    [2930, 'chamila.travels@acorn.lk'],  // Chamila Wijethunge
    [3822, 'amanda.travels@acorn.lk'],  // Amanda Ebert
    [20484, 'commonusers@acorn.lk'],  // Ruvinga Perera
    [20262, 'achini.s@lk.dth.travel'],  // Achini Samarathunga
    [20198, 'kithmi.w@lk.dth.travel'],  // Kithmi Warnasooriya
    [9310, 'nishadhya.travels@acorn.lk'],  // Nishadhya Arseculeratne
    [9874, 'rochely.travels@acorn.lk'],  // Rochely Wickramatillake
    [12676, 'pushpe.travels@acorn.lk'],  // Pushpakumara Jayawardana
    [10818, 'rizwan.travels@acorn.lk'],  // Rizwan Razak
    [20509, 'daisy.travels@acorn.lk'],  // Daisy Victor
    [20415, 'saliya.travels@acorn.lk'],  // Saliya Gunawardana
    [20528, 'praveen.finance@acorn.lk'],  // Praveen Fernando
    [20406, 'rasanjalee.hr@acorn.lk'],  // Rasanjalee Fernando
    [20489, 'subhani@aib.lk'],  // Subhani Dissanayaka
    [20309, 'dilini@travelservices.mv'],  // Dilini Thalagala
    [2968, 'tc1@lk.dth.travel'],  // Dilini Sendapperuma
    [3726, 'prasanna.r@lk.dth.travel'],  // Prasanna Rajapakse
    [4202, 'sameera.j@lk.dth.travel'],  // Sameera Jayasinghe
    [5877, 'rajitha.j@lk.dth.travel'],  // Rajitha Jayasena
    [20518, 'shiraj.ventures@acorn.lk'],  // Shiraj Juheer
    [20261, 'janaka.aviation@acorn.lk'],  // Janaka Kudavithana
    [20254, 'rajeeban.indigo@acorn.lk'],  // Rajeeban Arumugam
    [20134, 'ameer.travels@acorn.lk'],  // Ameer Rasseedin
    [20075, 'mewan.travels@acorn.lk'],  // Sirimewan Rodrigo
    [20433, 'cargo.sales@aviationservices.mv'],  // Chanaka Madushan
    [20166, 'brian@travelservices.mv'],  // Brian Williams
    [10508, 'ruznie.travels@acorn.lk'],  // Ruznie Shaideen
    [20084, 'fiona.j@lk.dth.travel'],  // Fiona Jansz
    [20089, 'adhil.g@lk.dth.travel'],  // Adhil Gaffoor
    [20197, 'pooja.s@lk.dth.travel'],  // Pooja Suram
    [20241, 'nazla.a@lk.dth.travel'],  // Nazla Ameer
    [20441, 'mariam.p@lk.dth.travel'],  // Mariam Peterson
    [20381, 'habeeb.travels@acorn.lk'],  // Habeeb Rahman
    [20345, 'dulanka@primedestinations.lk'],  // Dulanka Thennakoon
    [20330, 'mahamarakkalage.dias@goindigo.in'],  // Shamal Dias
    [14161, 'farhana.aviation@acorn.lk'],  // Farhana Agees
    [20424, 'anold.francis@goindigo.in'],  // Francis Anold
    [20465, 'lakmali.travels@acorn.lk'],  // LAKMALI GANGODA GAMACHCHIGE
    [20093, 'hemanthi.travels@acorn.lk'],  // Hemanthi Jayasinghe
    [20180, 'shazin.travels@acorn.lk'],  // Shazin Ahamed
    [20346, 'asith@primedestinations.lk'],  // Asith Fernando
    [20242, 'dinusha.travels@acorn.lk'],  // Dinusha Balapatabendi
    [20493, 'asela.indigo@acorn.lk'],  // Asela Amarasinghe
    [20398, 'archana.indigo@acorn.lk'],  // Archana Kajan
    [20240, 'supun.k@lk.dth.travel'],  // Supun Kandanarachchi
    [20448, 'poojani.s@lk.dth.travel'],  // Poojani Sumanasekera
    [20483, 'harshani.finance@acorn.lk'],  // Harshani Kumaranayaka
    [20400, 'virochana.finance@acorn.lk'],  // Virochana Liayange
    [20378, 'thanura@acornleisure.lk'],  // Thanura Karunarathna
    [20122, 'sunithi.travels@acorn.lk'],  // Sunithi Perera
    [20413, 'charith.marketing@acorn.lk'],  // Charith Samarakoon
    [20244, 'lahiru.hr@acorn.lk'],  // Lahiru Alahakoon
    [20316, 'viroshana.ventures@acorn.lk'],  // Viroshana Herath
    [13654, 'bhagyapiyumi359@gmail.com'],  // Lashika De Silva
    [10865, 'kumudu.aviation@acorn.lk'],  // Kumudu Jayalath
    [19672, 'subash@aviationservices.mv'],  // Subash George
    [20243, 'suhail@travelservices.mv'],  // Suhail Riyal
    [20360, 'janitha.finance@acorn.lk'],  // Janitha Samarasinghe
    [20458, 'tharindud.finance@acorn.lk'],  // Tharindu Dissanayaka
    [20529, 'jeewan.finance@acorn.lk'],  // Jeewan Bothejue
    [13120, 'lasitha.aviation@acorn.lk'],  // Lasitha Silva
    [20269, 'commonusers@acorn.lk'],  // Sawarimuthu Jeyaprakash
    [19682, 'dushy@acorn.lk'],  // Dushy Jayaweera
    [19683, 'suranjith@acorn.lk'],  // Suranjith De Fonseka
    [20071, 'commonusers@acorn.lk'],  // Tuan Sukarno Mashood
    [19475, 'commonusers@acorn.lk'],  // Samantha De Silva
    [20434, 'nashali.travels@acorn.lk'],  // Nashali Vanhoff
    [20432, 'shakir.travels@acorn.lk'],  // Mohamed Shakir
    [20069, 'arshad.travels@acorn.lk'],  // Arshad Hathy
    [20335, 'tryston.finance@acorn.lk'],  // Tryston Silva
    [20517, 'imesh.finance@acorn.lk'],  // Imesh Hetti Arachchige
    [20436, 'piyumi.hr@acorn.lk'],  // Piyumi Ranadeera
    [20526, 'vinoli@primedestinations.lk'],  // Vinoli Peiris
    [20206, 'ayeshmantha.travels@acorn.lk'],  // Ayeshmantha Lokumudali
    [20193, 'ahamed.travels@acorn.lk'],  // AHAMED CADER
    [20440, 'rukshan.aviation@acorn.lk'],  // Rukshan Rozairo
    [20138, 'fitsales@mv.dth.travel'],  // Dinidu Rathnasiri
    [20507, 'chamesha.aviation@acorn.lk'],  // Chamesha Fernando
    [20486, 'deloshan.aviation@acorn.lk'],  // Deloshan Sivajothy
    [20480, 'tharuka.travels@acorn.lk'],  // Tharuka Dissanayake
    [20410, 'neshankaran.travels@acorn.lk'],  // Vijeyasundaram Neshankaran
    [20154, 'cynthia.travels@acorn.lk'],  // Cynthia Fernando
    [20178, 'aron.travels@acorn.lk'],  // Aron Sabthihan
    [20055, 'rushaid.travels@acorn.lk'],  // Mohamed Rushaid
    [20350, 'sumali.finance@acorn.lk'],  // Sumali De Alwis
    [20213, 'harithindra@acornic.vc'],  // Harith Indra
    [20245, 'shamal.indigo@acorn.lk'],  // Shamal Wickramaratne
    [20107, 'gyan@acorn.lk'],  // Gyan Amerasinghe
    [19477, 'harith@acorn.lk'],  // Harith Perera
    [20092, 'nimali@acorn.lk'],  // Nimali Welikala
    [20317, 'gamunu@LANTERNTRAILS.TRAVEL'],  // Gamunu Rathnayake
    [20331, 'thilinih.travels@acorn.lk'],  // Thilini Herath
    [20353, 'mohanlal.travels@acorn.lk'],  // Mohanlal De Silva
    [20354, 'rohanr.travels@acorn.lk'],  // Rohan  Ranasinghe
    [20355, 'beverley.travels@acorn.lk'],  // Beverley  Adams
    [20388, 'nilmini.travels@acorn.lk'],  // Nilmini  Abeysinghe
    [20474, 'commonusers@acorn.lk'],  // Buddhi  Gunawardena
    [20475, 'commonusers@acorn.lk'],  // Palitha  Sumanasekara
    [20468, 'indika.travels@acorn.lk'],  // Indika Perera
    [20429, 'nihara.travels@acorn.lk'],  // Nihara Karim
    [20422, 'angie.travels@acorn.lk'],  // Angeline Gomesz
    [20423, 'niranjan.travels@acorn.lk'],  // Niranjan Ellepola
    [20421, 'udith.finance@acorn.lk'],  // Udith Perera
    [20485, 'senesh.finance@acorn.lk'],  // Senesh Harischandra
    [20414, 'pradeep@aviationservices.mv'],  // Pradeep Madhuranga
    [20110, 'naradha.finance@acorn.lk'],  // Naradha Rajakaruna
    [20408, 'clifford.finance@acorn.lk'],  // Clifford Frugtniet
    [20152, 'kalana.hr@acorn.lk'],  // Kalana Weerasinghe
    [20200, 'ganga.hr@acorn.lk'],  // Ganga De Mel
    [20420, 'lakshitha.it@acorn.lk'],  // Lakshitha Sandaruwan
    [20501, 'munaf.travels@acorn.lk'],  // Mohomed Aathif
    [20531, 'vidushan.n@lk.dth.travel'],  // Vidushan  Namasivayam
    [7222, 'chathura.it@acorn.lk'],  // Chathura Widana
    [20044, 'fitsales2@mv.dth.travel'],  // Pravin Kalahearachchi
    [20247, 'umaya.travels@acorn.lk'],  // Umaya Bulathsinghala
    [20519, 'clifton@primedestinations.lk'],  // Clifton Outschoorn
    [20306, 'hashini.travels@acorn.lk'],  // Hashini Yohansi
    [20211, 'yasindu.aviation@acorn.lk'],  // Yasindu De Silva
    [20194, 'chamithi.travels@acorn.lk'],  // Chamithi Palandegedara
    [20195, 'anky.travels@acorn.lk'],  // Anky Herath Mudiyanselage
    [20411, 'kavindi.travels@acorn.lk'],  // Kavindi Dharmabandu
    [20446, 'chathurangi.finance@acorn.lk'],  // Chathurangi Dayarathne
    [20491, 'sumali@aib.lk'],  // Sumali Liyadipita
    [20322, 'vinuri@primedestinations.lk'],  // Vinuri Ramanayake
    [20416, 'rahul.travels@acorn.lk'],  // Rahul Saravanam
    [20437, 'contracting@mv.dth.travel'],  // Dulakshika Deshani
    [20506, 'groups.indigo@acorn.lk'],  // Moorthy Miriam
    [20488, 'commonusers@acorn.lk'],  // Hifaz Hilmy Hussain
    [20321, 'thilothi@primedestinations.lk'],  // Thilothi Ravichandra
    [20397, 'himashi.finance@acorn.lk'],  // Himashi De Silva
    [20403, 'jehani.finance@acorn.lk'],  // Jehani Cooray
    [20370, 'jithmini.finance@acorn.lk'],  // Jithmini Hewa Witharanage
    [20371, 'geeshan.finance@acorn.lk'],  // Gashitha Ranasinghe
    [20278, 'sewmini.g@lk.dth.travel'],  // Sewmini Gunawardena
    [20464, 'fitsales3@mv.dth.travel'],  // Chamudi Gunawardhana
    [20494, 'operations@dertourgroup-maldives.com'],  // Tharusha Sandepa
    [4029, 'raishmi.travels@acorn.lk'],  // Raishmi Pinto
    [20463, 'shiran@LANTERNTRAILS.TRAVEL'],  // Shiran Kumar
    [11824, 'dilan.aviation@acorn.lk'],  // Dilan Jayakody
    [20470, 'dilanka.p@lk.dth.travel'],  // Dilanka Perera
    [20291, 'Dona.jayasinghe@goindigo.in'],  // Sheroni Jayasinghe D
    [20292, 'kusal.gedara@goindigo.in'],  // Kusal Kodithuwakku K G
    [20052, 'lakshika.vithanage@goindigo.in'],  // Lakshika Dilrukshi
    [18139, 'ravin.aviation@acorn.lk'],  // Ravin Amerasinghe
    [20357, 'kivindu.finance@acorn.lk'],  // Kivindu Thennakoon
    [20255, 'sakuntha.colambage@goindigo.in'],  // Sakuntha Fernando
    [20059, 'Priyanka.kankanamge1@goindigo.in'],  // Priyanka Chandima
    [13275, 'lilan.m@lk.dth.travel'],  // Lilan Mirando
    [20490, 'Dulan.d@lk.dth.travel'],  // Dulan Dharmarathne
    [8009, 'amri.n@lk.dth.travel'],  // Amri Noordeen
    [8641, 'dilakshan.s@lk.dth.travel'],  // Dilakshan Sirinivasagam
    [9059, 'ilusha.d@lk.dth.travel'],  // Ilusha Fernando
    [7045, 'durga.r@lk.dth.travel'],  // Durga Ramanan
    [20257, 'Nikhil.k@GOINDIGO.IN'],  // Nikhil  Varma
    [20530, 'commonusers@acorn.lk'],  // Ibrahim Mohamed
    [14164, 'nadun.travels@acorn.lk'],  // Nadun Subasinghe
    [20009, 'admin.aviation@acorn.lk'],  // Samantha Mal
    [18211, 'commonusers@acorn.lk'],  // Shanmugam Kathiresan
    [14980, 'visa.travels@acorn.lk'],  // Rejee Johnson
    [20473, 'commonusers@acorn.lk'],  // Sanchitha Sankalpa
    [20363, 'commonusers@acorn.lk'],  // Nadeesha Silva
    [20358, 'kamil.finance@acorn.lk'],  // Mohamed Kamil
    [2045, 'commonusers@acorn.lk'],  // Sarath Disanayake
    [20295, 'hgops1@mv.dth.travel'],  // Lasini Diyes
    [20146, 'procurement-2@lk.dth.travel'],  // Dhanusha Laksitha
    [20516, 'procurement-3@mv.dth.travel'],  // Dilki Mendis
    [943, 'carmen.k@mv.dth.travel'],  // Carmen Kronemberg
    [20076, 'jacquelin.travels@acorn.lk'],  // Jacquelin Kasunka
    [20487, 'lishanthan@travelservices.mv'],  // Lishanthan Sockalingam
    [20064, 'ops1@aviationservices.mv'],  // Melmari Cruse
    [20307, 'servicefullfilment2@lk.dth.travel'],  // Priyantha Kaviraja
    [20401, 'pavithri.hr@acorn.lk'],  // Pavithri Thejani
    [20163, 'aruna.admin@acorn.lk'],  // Aruna Perera
    [20344, 'chaithri@primedestinations.lk'],  // Chaithri Kuragama
    [5801, 'shane.f@lk.dth.travel'],  // Shane Felsinger
    [20115, 'kris.travels@acorn.lk'],  // Kris Chandrasekaran
    [20123, 'samudrika.hr@acorn.lk'],  // Samudrika Ranadeva
    [20315, 'sanka.it@acorn.lk'],  // Sanka Jhonsge
    [20212, 'roshan.aviation@acorn.lk'],  // Roshan Rumantha
    [9980, 'hirusha.aviation@acorn.lk'],  // Hirusha Wickramaratne
    [10732, 'sujan.aviation@acorn.lk'],  // Sujan Fernando
    [20525, 'ruchira.aviation@acorn.lk'],  // Ruchira Kumara
    [10901, 'hasitha.aviation@acorn.lk'],  // Hasitha Wanniarachchi
    [19815, 'bathiya.aviation@acorn.lk'],  // Bathiya Senadhipathi
    [20417, 'udara.aviation@acorn.lk'],  // Udara Hettiarachchi
    [20466, 'akalanka.aviation@acorn.lk'],  // Wedeha Akalanka
    [20431, 'cashier.dth@acorn.lk'],  // Dilum Kumara
    [20362, 'cashier.travels@acorn.lk'],  // Rajeewa Henry
    [20407, 'cashier.apd@primedestinations.lk'],  // Madushan Fernando
    [20339, 'cashier.aviation@acorn.lk'],  // Rajesh Priyankara
    [19665, 'malinga@acorn.lk'],  // Malinga Arsakularatne
    [20520, 'raj.leisure@acorn.lk'],  // Kokularajah Sundararajah
    [2188, 'priyanga.travels@acorn.lk'],  // Priyanga Perera
    [20443, 'pruthivi@aib.lk'],  // Pruthivi  Chamupathi
    [20524, 'aravinda.aviation@acorn.lk'],  // Aravinda Nelumdeniya
    [20094, 'damith.travels@acorn.lk'],  // Damith Abeyrathne
    [20062, 'Shalini.k@goindigo.in'],  // Shalini Dharmapriya
    [20505, 'dhauha@aviationservices.mv'],  // Dhauha Shareef
    [19680, 'himali.finance@acorn.lk'],  // Himali Samaraweera
    [9409, 'thushanth.finance@acorn.lk'],  // Thushanth Nageswaran
    [20324, 'tharindu.finance@acorn.lk'],  // Tharindu Lakmal
    [20333, 'vipula.finance@acorn.lk'],  // Vipula Rathnayaka
    [20366, 'menusha.finance@acorn.lk'],  // Menusha Amandhi
    [20367, 'malith.finance@acorn.lk'],  // Malith Dinujaya
    [20409, 'theekshani.finance@acorn.lk'],  // Theekshani Silva
    [20445, 'sameera.finance@aviationservices.mv'],  // Sameera Perera
    [20482, 'benali.ventures@acorn.lk'],  // Benali Gunawardena
    [20560, 'dinushika.finance@acorn.lk'],  // Dinushika Rajapaksha
    [20540, 'poornima@acornleisure.lk'],  // Poornima Karunarathna
    [20541, 'ops1@LANTERNTRAILS.TRAVEL'],  // Bhagya Palihawadana
    [20542, 'kumudu.travels@acorn.lk'],  // Kumudu Kannangara
    [20544, 'shamal@acornic.vc'],  // Shamal  Rathnayaka
    [20545, 'musthaq.travels@acorn.lk'],  // Musthaq Ahamed
    [20547, 'commonusers@acorn.lk'],  // Basil Fernando
    [20551, 'bhanukad.aviation@acorn.lk'],  // Bhanuka Desilva
    [20552, 'salpadoruge.fernando@goindigo.in'],  // Dilip  Fernando
    [20553, 'aravindan@primedestinations.lk'],  // Ravindrasena Aravindan
    [20557, 'lithira@primedestinations.lk'],  // Lithira Yasaswin Hewadewage
    [20558, 'lukman@primedestinations.lk'],  // Lukman  Hakeem
    [20563, 'commonusers@acorn.lk'],  // Nipuni Perera
    [20539, 'subanu.ventures@acorn.lk'],  // Subanu Perera
    [20561, 'senuri.finance@acorn.lk'],  // Senuri Ranatunga
    [20564, 'tuan.travels@acorn.lk'],  // Tuan Kamaldeen
    [20577, 'lasith@primedestinations.lk'],  // Lasith Lochana
    [20508, 'nelum@aib.lk'],  // Nelum Weragoda
    [20566, 'ruwan.k@lk.dth.travel'],  // Ruwan Kumara
    [20578, 'chrishika.f@lk.dth.travel'],  // Chrishika Fernando
    [20579, 'vinduli.t@lk.dth.travel'],  // Vinduli Thilakarathne
    [20580, 'servicefullfilment@lk.dth.travel'],  // Disnaka  Rathnayake
    [20581, 'niruni.w@lk.dth.travel'],  // Niruni Walawedurage
    [20583, 'mineli.leisure@acorn.lk'],  // Mineli Wegodapola
    [20584, 'randula.indigo@acorn.lk'],  // Randula Ruwanpathirana
    [20582, 'apt.ops1@aviationservices.mv'],  // Ahmed Sharoof
    [20585, 'eymariyamsharam@etihad.ae'],  // Mariyam  Mohamed
    [20586, 'kate@travelservices.mv'],  // Kate Bohol
    [20588, 'wasantha@aib.lk'],  // Wasantha  Kumara
    [20590, 'pathum.f@mv.dth.travel'],  // Pathum Fernando
    [20592, 'sinduja.aviation@acorn.lk'],  // Sinduja Ranjithkumar
    [20594, 'jeewani.finance@acorn.lk'],  // Jeewani Senadeera
    [20589, 'mahela.it@acorn.lk'],  // Mahela Perera
    [20593, 'madhavee.ventures@acorn.lk'],  // Madhavee Hemamali
    [20603, 'sassanka.leisure@acorn.lk'],  // Sassanka De Silva
    [20567, 'commonusers@acorn.lk'],  // Thushara Kelum
    [20569, 'commonusers@acorn.lk'],  // Amila Kumara
    [20570, 'commonusers@acorn.lk'],  // Royston Macdonald
    [20571, 'commonusers@acorn.lk'],  // Manjula Senavirathna
    [20572, 'commonusers@acorn.lk'],  // Nuwan Jayathilaka
    [20568, 'commonusers@acorn.lk'],  // Chaminda Kariyawasam
    [20599, 'commonusers@acorn.lk'],  // Mahinda Thilakaratne
    [20596, 'commonusers@acorn.lk'],  // Niranjan Motha
    [20597, 'coordinator@mv.dth.travel'],  // Thakshanie Sara
    [20601, 'kamal.travels@acorn.lk'],  // Kamal Raj
    [20607, 'clifton.travels@acorn.lk'],  // Clifton Outschoorn
    [20609, 'sherleen.travels@acorn.lk'],  // Sherleen Radan
    [20611, 'anitha.travels@acorn.lk'],  // Anitha Elangowan
    [20610, 'rosmiyanthivasudevan@gmail.com'],  // Vasudevan Rosmiyanthi
    [20591, 'ops2@aviationservices.mv'],  // Muzdhalifa Ahmed
    [20612, 'shanuka.finance@acorn.lk'],  // Shanuka Jayanatha
    [20613, 'supuni.ventures@acorn.lk'],  // Supuni Pihillegedara
    [20614, 'ops@LANTERNTRAILS.TRAVEL'],  // Sheron Pinto
    [20615, 'janith.leisure@acorn.lk'],  // Janith Meddawatta
    [20616, 'ashani.travels@acorn.lk'],  // Ashani Nimesha
    [20617, 'krishan.travels@acorn.lk'],  // Krishan Perera
    [20620, 'rayhan.m@lk.dth.travel'],  // Rayhan Malik
    [20621, 'ridmi.hr@acorn.lk'],  // Ridmi Rassapana
    [20619, 'commonusers@acorn.lk'],  // Nandana Wijenayake
    [20618, 'saminda@acorn.lk'],  // Saminda Weerasinghe
    [20623, 'maliesha.ventures@acorn.lk'],  // Maliesha Liyanahewa
    [20624, 'dilini.r@lk.dth.travel'],  // Dilini Ranasinghe
    [20625, 'rishad.r@lk.dth.travel'],  // Ahamed Rishad
    [20622, 'munira.travels@acorn.lk'],  // Munira Khuzaima
    [20626, 'creative.design@lk.dth.travel'],  // Roshan Fernando
    [20627, 'ezekiel.leisure@acorn.lk'],  // Ezekiel Gunawardena
    [20629, 'cargo.ops@aviationservices.mv'],  // Sithija Gunawardhana
    [2628, 'kaveesha.t@mv.dth.travel'],  // Kaveesha Thathsarani
  ];

  let matched = 0, notFound = 0, skipped = 0;
  for (const [empNo, email] of updates) {
    const user = db.prepare('SELECT emp_no, name FROM users WHERE emp_no=?').get(empNo);
    if (user) {
      db.prepare('UPDATE users SET email=? WHERE emp_no=?').run(email, empNo);
      matched++;
    } else {
      console.log('  Not found in DB: emp_no=' + empNo);
      notFound++;
    }
  }

  db.saveToDisk();
  console.log('');
  console.log('=== DONE ===');
  console.log(matched + ' email addresses saved');
  console.log(notFound + ' employee numbers not found in DB');
  console.log('');
  console.log('You can now restart the server.');
}

run().catch(function(err) {
  console.error('Error:', err.message);
  process.exit(1);
});
