'use strict';
/**
 * blocklist-seed.js — the starting trademark/IP blocklist (SEED_VERSION below).
 *
 * What this is: names and phrases that print-on-demand sellers are commonly struck for, grouped by kind.
 * What it is NOT: legal advice, a trademark search, or complete. Trademark scope depends on the goods and the
 * jurisdiction; this list cannot know either. Its job is to make the obvious cases impossible to miss, not to clear a design.
 * Whether any phrase here is currently registered, and for which goods, was NOT checked (assumed, unverified, 2026-10-05).
 *
 * Authoring rules (they are what keep false positives down; see domain/blocklist.js for the matcher):
 *  - A common English word is NOT listed on its own (apple, supreme, coach, gap, guess, jaguar, puma, giants, celtic,
 *    tesla, mustang...). It is listed as the phrase that makes it a brand ("apple watch", "new york giants", "puma logo").
 *  - Terms are lower-case. Hyphen / space / joined variants, plurals and possessives are handled by the matcher, so list
 *    each name once ("spider-man" also catches "spider man", "spiderman" and "Spider-Man's").
 *  - Where a legitimate use shares a name (nikola tesla, supreme court) the matcher's EXCEPTIONS list removes the hit.
 *
 * Operators edit the live table in the panel (Settings -> Blocklist). A bumped SEED_VERSION adds new seed terms to an
 * existing database but never re-adds one the operator removed (those are remembered in settings `blocklist_removed`).
 */
const SEED_VERSION = 2;

const L = s => s.split('\n').map(x => x.trim().toLowerCase()).filter(Boolean);

const SEED = {
  brand: L(`
nike
adidas
puma logo
puma sportswear
reebok
new balance
under armour
asics
vans off the wall
jordan brand
air jordan
yeezy
fila
champion athleticwear
lululemon
gymshark
the north face
patagonia
columbia sportswear
carhartt
dickies
levis
wrangler jeans
calvin klein
tommy hilfiger
ralph lauren
polo ralph lauren
lacoste
hugo boss
gucci
prada
louis vuitton
chanel
hermes
versace
burberry
balenciaga
dior
fendi
givenchy
armani
dolce gabbana
yves saint laurent
michael kors
kate spade
coach handbags
tiffany and co
cartier
rolex
omega watches
casio g-shock
off-white
bape
a bathing ape
stussy
supreme new york
supreme box logo
supreme brand
palace skateboards
obey giant
hollister
abercrombie
american eagle outfitters
old navy
victoria's secret
pink by victoria
disney
walt disney
pixar
marvel
dc comics
warner bros
universal studios
dreamworks
nickelodeon
cartoon network
hasbro
mattel
lego
playmobil
funko
fisher-price
hot wheels
barbie
my little pony
care bears
cabbage patch
squishmallow
beanie babies
tamagotchi
nerf
play-doh
crayola
sanrio
apple watch
apple logo
apple inc
iphone
ipad
macbook
airpods
google pixel
microsoft windows
xbox
playstation
nintendo
sega
atari
samsung galaxy
amazon prime
netflix
spotify
youtube
tiktok
instagram
facebook
twitter
snapchat
whatsapp
linkedin
reddit
twitch
discord
roblox
fortnite
epic games
steam deck
tesla motors
tesla cybertruck
tesla model
spacex
ford mustang
chevrolet
chevy
corvette
dodge charger
dodge challenger
jeep wrangler
harley-davidson
ducati
yamaha
kawasaki
suzuki
honda
toyota
subaru
bmw
mercedes-benz
mercedes benz
audi
porsche
ferrari
lamborghini
maserati
bugatti
bentley
rolls-royce
mclaren
jaguar cars
land rover
volkswagen
volvo
mini cooper
nissan
mazda
lexus
coca-cola
coke zero
pepsi
mountain dew
dr pepper
fanta
red bull
monster energy
gatorade
powerade
budweiser
bud light
miller lite
coors light
heineken
corona extra
guinness
jack daniel's
jim beam
jameson
captain morgan
smirnoff
absolut
jagermeister
patron tequila
fireball whisky
tito's vodka
starbucks
dunkin
mcdonald's
burger king
wendy's
taco bell
kfc
subway sandwiches
chick-fil-a
pizza hut
domino's
chipotle
in-n-out
five guys
krispy kreme
tim hortons
dairy queen
popeyes
hershey
reese's
m&m's
oreo
skittles
snickers
kit kat
cheetos
doritos
pringles
lay's
twinkies
pop-tarts
kellogg's
frosted flakes
froot loops
lucky charms
cheerios
nutella
tabasco
heinz
velveeta
campbell's soup
yeti coolers
yeti tumbler
stanley cup
stanley tumbler
hydro flask
owala
contigo
tupperware
crocs
jibbitz
birkenstock
ugg
timberland
dr martens
skechers
hoka
brooks running
salomon
oakley
ray-ban
costco
walmart
target stores
home depot
lowe's
ikea
trader joe's
whole foods
cvs pharmacy
walgreens
ebay
etsy
shopify
uber
lyft
airbnb
paypal
mastercard
american express
nfl shop
hallmark
carter's
gerber
pampers
huggies
tylenol
band-aid
kleenex
vaseline
chapstick
sharpie
post-it
scotch tape
velcro
zippo
swiss army
leatherman
craftsman
dewalt
milwaukee tools
john deere
caterpillar
kubota
stihl
husqvarna
traeger
weber grill
blackstone griddle
polaroid
kodak
gopro
nikon
canon eos
converse all star
chuck taylor
sony
bose
beats by dre
jbl
sonos
fitbit
garmin
peloton
`),

  league: L(`
nfl
national football league
nba
national basketball association
wnba
mlb
major league baseball
nhl
national hockey league
mls
major league soccer
nwsl
ncaa
fifa
uefa
premier league
la liga
bundesliga
serie a
champions league
world cup
olympics
olympic games
ufc
ultimate fighting championship
wwe
world wrestling entertainment
aew
nascar
formula 1
formula one
indycar
pga tour
lpga
atp tour
wta tour
us open tennis
wimbledon
super bowl
stanley cup finals
march madness
final four
world series
nba finals
the masters tournament
ryder cup
tour de france
little league
cfl
xfl
usfl
`),

  team: L(`
arizona cardinals
atlanta falcons
baltimore ravens
buffalo bills
carolina panthers
chicago bears
cincinnati bengals
cleveland browns
dallas cowboys
denver broncos
detroit lions
green bay packers
houston texans
indianapolis colts
jacksonville jaguars
kansas city chiefs
las vegas raiders
oakland raiders
los angeles chargers
san diego chargers
los angeles rams
miami dolphins
minnesota vikings
new england patriots
new orleans saints
new york giants
new york jets
philadelphia eagles
pittsburgh steelers
san francisco 49ers
seattle seahawks
tampa bay buccaneers
tennessee titans
washington commanders
washington redskins
atlanta hawks
boston celtics
brooklyn nets
charlotte hornets
chicago bulls
cleveland cavaliers
dallas mavericks
denver nuggets
detroit pistons
golden state warriors
houston rockets
indiana pacers
los angeles clippers
los angeles lakers
memphis grizzlies
miami heat
milwaukee bucks
minnesota timberwolves
new orleans pelicans
new york knicks
oklahoma city thunder
orlando magic
philadelphia 76ers
phoenix suns
portland trail blazers
sacramento kings
san antonio spurs
toronto raptors
utah jazz
washington wizards
lakers
celtics
knicks
warriors nba
arizona diamondbacks
atlanta braves
baltimore orioles
boston red sox
chicago cubs
chicago white sox
cincinnati reds
cleveland guardians
cleveland indians
colorado rockies
detroit tigers
houston astros
kansas city royals
los angeles angels
los angeles dodgers
miami marlins
milwaukee brewers
minnesota twins
new york mets
new york yankees
oakland athletics
philadelphia phillies
pittsburgh pirates
san diego padres
san francisco giants
seattle mariners
st louis cardinals
tampa bay rays
texas rangers
toronto blue jays
washington nationals
yankees
red sox
dodgers
cubbies
anaheim ducks
arizona coyotes
boston bruins
buffalo sabres
calgary flames
carolina hurricanes
chicago blackhawks
colorado avalanche
columbus blue jackets
dallas stars
detroit red wings
edmonton oilers
florida panthers
los angeles kings
minnesota wild
montreal canadiens
nashville predators
new jersey devils
new york islanders
new york rangers
ottawa senators
philadelphia flyers
pittsburgh penguins
san jose sharks
seattle kraken
st louis blues
tampa bay lightning
toronto maple leafs
vancouver canucks
vegas golden knights
washington capitals
winnipeg jets
manchester united
manchester city
liverpool fc
chelsea fc
arsenal fc
tottenham hotspur
real madrid
fc barcelona
atletico madrid
bayern munich
borussia dortmund
juventus
ac milan
inter milan
paris saint-germain
psg
inter miami
la galaxy
seattle sounders
alabama crimson tide
ohio state buckeyes
michigan wolverines
notre dame fighting irish
texas longhorns
georgia bulldogs
clemson tigers
lsu tigers
oklahoma sooners
florida gators
penn state nittany lions
duke blue devils
north carolina tar heels
kentucky wildcats
kansas jayhawks
ucla bruins
usc trojans
`),

  franchise: L(`
star wars
star trek
harry potter
hogwarts
the lord of the rings
the hobbit
game of thrones
house of the dragon
stranger things
the mandalorian
baby yoda
grogu
the walking dead
the matrix movie
jaws movie
ice age scrat
dunder mifflin
michael scott
dwight schrute
breaking bad
better call saul
parks and recreation
friends tv show
seinfeld
the simpsons
family guy
south park
rick and morty
bob's burgers
futurama
american dad
adventure time
steven universe
gravity falls
avatar the last airbender
spongebob
spongebob squarepants
bluey
peppa pig
paw patrol
cocomelon
sesame street
barney and friends
teletubbies
thomas the tank engine
blue's clues
dora the explorer
ms rachel
sofia the first
frozen disney
disney frozen
elsa frozen
frozen elsa
moana
encanto
coco pixar
toy story
finding nemo
finding dory
monsters inc
the incredibles
cars pixar
up pixar
the lion king
hakuna matata
aladdin
the little mermaid
beauty and the beast
cinderella disney
sleeping beauty disney
snow white disney
winnie the pooh
lilo and stitch
the nightmare before christmas
tim burton
mickey mouse
minnie mouse
donald duck
goofy disney
pluto disney
mickey and friends
the avengers
avengers endgame
guardians of the galaxy
black panther wakanda
black panther marvel
x-men
deadpool
wolverine marvel
fast and furious
james bond
007
jurassic park
jurassic world
indiana jones
back to the future
ghostbusters
top gun
terminator
alien xenomorph
predator movie
rocky balboa
rambo
mad max
the godfather
scarface
pulp fiction
fight club
nightmare on elm street
friday the 13th
halloween michael myers
texas chain saw massacre
scream ghostface
saw jigsaw
it pennywise
e.t. the extra-terrestrial
the goonies
gremlins
beetlejuice
the princess bride
dirty dancing
mean girls
legally blonde
the breakfast club
ferris bueller
home alone
elf the movie
the grinch
how the grinch stole christmas
dr seuss
the cat in the hat
green eggs and ham
the lorax
horton hears a who
peanuts gang
charlie brown
the wizard of oz
alice in wonderland disney
peter pan disney
tinker bell
mulan
pocahontas
hercules disney
brave pixar
ratatouille
wall-e
zootopia
big hero 6
wreck-it ralph
shrek
madagascar
kung fu panda
how to train your dragon
despicable me
minions
sing movie
the secret life of pets
rio movie
trolls movie
the super mario bros
super mario
mario kart
legend of zelda
the legend of zelda
zelda
animal crossing
splatoon
kirby
donkey kong
metroid
pokemon
pokémon
pikachu
charizard
eevee
jigglypuff
snorlax
mewtwo
squirtle
bulbasaur
charmander
gengar
yu-gi-oh
digimon
dragon ball
dragon ball z
naruto
one piece anime
bleach anime
my hero academia
attack on titan
demon slayer
jujutsu kaisen
sailor moon
death note
cowboy bebop
neon genesis evangelion
fullmetal alchemist
hunter x hunter
studio ghibli
my neighbor totoro
spirited away
howl's moving castle
kiki's delivery service
princess mononoke
hello kitty
my melody
kuromi
cinnamoroll
pompompurin
pochacco
badtz-maru
keroppi
gudetama
rilakkuma
sonic the hedgehog
mega man
street fighter
mortal kombat
tekken
final fantasy
kingdom hearts
resident evil
silent hill
metal gear solid
halo xbox
gears of war
call of duty
battlefield
overwatch
world of warcraft
warcraft
diablo
starcraft
league of legends
valorant
counter-strike
apex legends
among us
minecraft
terraria
stardew valley
undertale
five nights at freddy's
fnaf
genshin impact
elden ring
dark souls
the witcher
cyberpunk 2077
grand theft auto
gta
red dead redemption
assassin's creed
the elder scrolls
skyrim
fallout
bioshock
portal valve
half-life
dota
hearthstone
clash of clans
candy crush
angry birds
subway surfers
pac-man
tetris
dungeons and dragons
dungeons & dragons
warhammer
magic the gathering
yu gi oh
hot wheels
transformers
g.i. joe
he-man
thundercats
teenage mutant ninja turtles
power rangers
voltron
gi joe
masters of the universe
care bear
strawberry shortcake
rainbow brite
polly pocket
bratz
lol surprise
shopkins
paw patrol
the muppets
fraggle rock
labyrinth movie
the dark crystal
the golden girls
i love lucy
the brady bunch
the addams family
the munsters
scooby-doo
scooby doo
the flintstones
the jetsons
looney tunes
bugs bunny
daffy duck
tweety bird
road runner
wile e coyote
tom and jerry
yogi bear
popeye
betty boop
felix the cat
garfield
snoopy
woodstock peanuts
curious george
winnie the pooh
paddington bear
peter rabbit
the very hungry caterpillar
where the wild things are
goodnight moon
pete the cat
llama llama
elmo
cookie monster
big bird
oscar the grouch
kermit the frog
miss piggy
smurfs
the smurfs
the snurfs
tintin
asterix
lucky luke
`),

  character: L(`
spider-man
batman
superman
wonder woman
aquaman
the flash dc
green lantern
harley quinn
the joker
catwoman
robin dc
supergirl
shazam
cyborg dc
iron man
captain america
thor marvel
hulk
black widow marvel
hawkeye marvel
doctor strange
ant-man
scarlet witch
loki marvel
thanos
venom marvel
miles morales
spider-gwen
captain marvel
groot
rocket raccoon
star-lord
gamora
mario
luigi
princess peach
bowser
yoshi
toad nintendo
wario
link zelda
princess zelda
ganon
samus aran
pikmin
fox mccloud
tails sonic
knuckles echidna
shadow the hedgehog
amy rose
lara croft
master chief
kratos
solid snake
cloud strife
sephiroth
pac man
mega man
ryu street fighter
scorpion mortal kombat
goku
vegeta
gohan
naruto uzumaki
sasuke
luffy
zoro
sailor moon
totoro
no-face
ponyo
pikachu
hello kitty
mickey mouse
minnie mouse
donald duck
daisy duck
goofy
pluto the dog
chip n dale
olaf
anna frozen
kristoff
simba
nala
mufasa
scar lion king
timon and pumbaa
ariel little mermaid
belle disney
jasmine disney
rapunzel
tiana
merida
mulan
pocahontas
moana
maui moana
mirabel
woody toy story
buzz lightyear
jessie toy story
lightning mcqueen
mater cars
sulley
mike wazowski
boo monsters inc
mr incredible
elastigirl
syd the kid
wall-e
eve wall-e
remy ratatouille
winnie the pooh
tigger
eeyore
piglet
bambi
dumbo
thumper
peter pan
tinker bell
captain hook
cruella de vil
maleficent
ursula
jafar
hades
darth vader
darth maul
luke skywalker
princess leia
han solo
chewbacca
yoda
obi-wan kenobi
anakin skywalker
kylo ren
rey skywalker
boba fett
jabba the hutt
r2-d2
c-3po
bb-8
stormtrooper
ahsoka tano
din djarin
grogu
spock
captain kirk
picard
harry potter
hermione granger
ron weasley
albus dumbledore
severus snape
draco malfoy
voldemort
hagrid
dobby
gandalf
frodo baggins
gollum
legolas
aragorn
sauron
bilbo baggins
tyrion lannister
daenerys targaryen
jon snow
arya stark
eleven stranger things
demogorgon
homer simpson
bart simpson
marge simpson
lisa simpson
maggie simpson
mr burns
ned flanders
krusty the clown
peter griffin
stewie griffin
brian griffin
eric cartman
kenny mccormick
stan marsh
kyle broflovski
rick sanchez
morty smith
spongebob
patrick star
squidward
mr krabs
sandy cheeks
plankton
bluey heeler
bingo heeler
peppa pig
george pig
chase paw patrol
skye paw patrol
marshall paw patrol
rubble paw patrol
snoopy
charlie brown
lucy van pelt
linus van pelt
woodstock
garfield
odie
bugs bunny
daffy duck
porky pig
tweety
sylvester the cat
road runner
tasmanian devil taz
foghorn leghorn
pepe le pew
speedy gonzales
scooby-doo
shaggy rogers
fred flintstone
barney rubble
yogi bear
boo boo bear
popeye
olive oyl
betty boop
felix the cat
tom and jerry
pink panther
woody woodpecker
casper the friendly ghost
dennis the menace
curious george
paddington
kermit
miss piggy
fozzie bear
gonzo muppet
elmo
cookie monster
big bird
grover
bert and ernie
shrek
donkey shrek
puss in boots
fiona shrek
gru
minion
po kung fu panda
toothless
hiccup
alex the lion
marty zebra
manny mammoth
sid sloth
scrat
dr eggman
crash bandicoot
spyro the dragon
rayman
sackboy
kirby
donkey kong
diddy kong
king k rool
captain falcon
ness earthbound
isabelle animal crossing
tom nook
mr peanut
tony the tiger
ronald mcdonald
the hamburglar
the kool-aid man
the pillsbury doughboy
colonel sanders
chester cheetah
the michelin man
geico gecko
flo progressive
the energizer bunny
duracell bunny
smokey bear
mr clean
jolly green giant
captain crunch
trix rabbit
lucky the leprechaun
snap crackle pop
sonny the cuckoo bird
count chocula
frankenberry
the noid
slimer
stay puft marshmallow man
pennywise
freddy krueger
jason voorhees
michael myers
leatherface
ghostface
chucky
pinhead
jigsaw puppet
annabelle doll
pumpkinhead
beetlejuice
jack skellington
sally nightmare before christmas
oogie boogie
zero nightmare before christmas
gizmo gremlins
e.t.
pee-wee herman
ferris bueller
forrest gump
rocky balboa
indiana jones
jack sparrow
captain jack sparrow
davy jones
james bond
austin powers
the dude lebowski
tony montana
vito corleone
darth
`),

  celebrity: L(`
taylor swift
swiftie
beyonce
beyoncé
rihanna
adele
drake rapper
kanye west
ye kanye
jay-z
eminem
kendrick lamar
travis scott
post malone
bad bunny
j balvin
karol g
shakira
ariana grande
billie eilish
olivia rodrigo
sabrina carpenter
chappell roan
dua lipa
lady gaga
katy perry
miley cyrus
selena gomez
demi lovato
justin bieber
justin timberlake
harry styles
one direction
ed sheeran
bruno mars
the weeknd
lizzo
doja cat
megan thee stallion
cardi b
nicki minaj
lil nas x
lil wayne
snoop dogg
dr dre
ice cube
tupac
2pac
notorious big
biggie smalls
nas rapper
50 cent
lana del rey
lorde
halsey
sza
tyler the creator
frank ocean
childish gambino
mac miller
juice wrld
xxxtentacion
lil uzi vert
playboi carti
21 savage
future rapper
gunna
bts
blackpink
twice kpop
stray kids
newjeans
seventeen kpop
exo kpop
elvis presley
michael jackson
prince rogers nelson
madonna
whitney houston
mariah carey
celine dion
cher
dolly parton
johnny cash
willie nelson
garth brooks
shania twain
taylor swift eras
morgan wallen
luke combs
zach bryan
chris stapleton
kacey musgraves
bob marley
bob dylan
jimi hendrix
janis joplin
jim morrison
kurt cobain
david bowie
freddie mercury
elton john
rod stewart
stevie nicks
fleetwood mac
bruce springsteen
tom petty
neil young
joni mitchell
eric clapton
ozzy osbourne
the beatles
john lennon
paul mccartney
george harrison
ringo starr
the rolling stones
mick jagger
led zeppelin
pink floyd
the who band
the doors band
queen band
ac/dc
acdc
metallica
iron maiden
black sabbath
guns n roses
nirvana band
pearl jam
soundgarden
foo fighters
green day
blink-182
red hot chili peppers
linkin park
my chemical romance
fall out boy
paramore
panic at the disco
twenty one pilots
imagine dragons
coldplay
radiohead
oasis band
the smiths
the cure
joy division
depeche mode
ramones
sex pistols
the clash
grateful dead
phish
dave matthews band
kiss band
van halen
aerosmith
def leppard
bon jovi
journey band
journey steve perry
toto band
rush band
yes band
genesis band
the eagles band
the monkees
abba
bee gees
beach boys
frank sinatra
dean martin
sammy davis jr
ella fitzgerald
louis armstrong
miles davis
john coltrane
michael jordan
lebron james
kobe bryant
stephen curry
steph curry
kevin durant
giannis antetokounmpo
luka doncic
shaquille o'neal
magic johnson
larry bird
allen iverson
tim duncan
dirk nowitzki
victor wembanyama
caitlin clark
tom brady
patrick mahomes
travis kelce
aaron rodgers
peyton manning
eli manning
joe montana
jerry rice
deion sanders
lamar jackson
josh allen
jalen hurts
joe burrow
derek jeter
babe ruth
shohei ohtani
aaron judge
mike trout
mookie betts
lionel messi
cristiano ronaldo
neymar
kylian mbappe
erling haaland
david beckham
pele
diego maradona
zlatan ibrahimovic
megan rapinoe
alex morgan
serena williams
venus williams
roger federer
rafael nadal
novak djokovic
coco gauff
naomi osaka
tiger woods
rory mcilroy
scottie scheffler
phil mickelson
arnold palmer
jack nicklaus
muhammad ali
mike tyson
floyd mayweather
conor mcgregor
jon jones
khabib nurmagomedov
ronda rousey
john cena
the rock dwayne johnson
dwayne johnson
stone cold steve austin
hulk hogan
ric flair
undertaker wwe
usain bolt
simone biles
michael phelps
katie ledecky
lewis hamilton
max verstappen
dale earnhardt
danica patrick
tony hawk
mr beast
mrbeast
pewdiepie
markiplier
ninja fortnite
kai cenat
ishowspeed
logan paul
jake paul
addison rae
charli d'amelio
khaby lame
emma chamberlain
james charles
elon musk
jeff bezos
mark zuckerberg
bill gates
steve jobs
warren buffett
oprah winfrey
kim kardashian
kylie jenner
kendall jenner
kourtney kardashian
khloe kardashian
paris hilton
donald trump
joe biden
kamala harris
barack obama
michelle obama
hillary clinton
bernie sanders
alexandria ocasio-cortez
ron desantis
vivek ramaswamy
jd vance
mike pence
nancy pelosi
mitch mcconnell
ronald reagan
john f kennedy
jfk
martin luther king
abraham lincoln
queen elizabeth ii
king charles
prince harry
meghan markle
prince william
kate middleton
princess diana
tom hanks
tom cruise
brad pitt
angelina jolie
leonardo dicaprio
johnny depp
robert downey jr
chris hemsworth
chris evans
chris pratt
ryan reynolds
ryan gosling
hugh jackman
keanu reeves
will smith
denzel washington
morgan freeman
samuel l jackson
dwayne the rock johnson
jason momoa
pedro pascal
timothee chalamet
timothée chalamet
zendaya
tom holland
florence pugh
margot robbie
emma watson
emma stone
jennifer lawrence
jennifer aniston
jennifer lopez
scarlett johansson
anne hathaway
sandra bullock
julia roberts
meryl streep
nicole kidman
natalie portman
ana de armas
sydney sweeney
jenna ortega
millie bobby brown
sadie sink
finn wolfhard
david harbour
bella ramsey
henry cavill
robert pattinson
kristen stewart
daniel radcliffe
rupert grint
benedict cumberbatch
idris elba
harrison ford
mark hamill
carrie fisher
arnold schwarzenegger
sylvester stallone
bruce willis
jackie chan
bruce lee
clint eastwood
john wayne
marilyn monroe
audrey hepburn
elizabeth taylor
james dean
marlon brando
humphrey bogart
charlie chaplin
robin williams
jim carrey
adam sandler
will ferrell
steve carell
kevin hart
dave chappelle
chris rock
eddie murphy
bill murray
betty white
bob ross
mr rogers
fred rogers
jerry seinfeld
ellen degeneres
jimmy fallon
jimmy kimmel
stephen colbert
trevor noah
joe rogan
andrew tate
jordan peterson
ben shapiro
tucker carlson
anthony fauci
greta thunberg
malala yousafzai
stephen hawking
albert einstein
neil degrasse tyson
`),

  phrase: L(`
just do it
i'm lovin' it
im lovin it
think different
have it your way
finger lickin' good
finger lickin good
the happiest place on earth
the most magical place on earth
may the force be with you
i volunteer as tribute
winter is coming
live long and prosper
to infinity and beyond
just keep swimming
ohana means family
expecto patronum
mischief managed
i solemnly swear that i am up to no good
always be yourself unless you can be a unicorn
you can't sit with us
on wednesdays we wear pink
make america great again
life is good
got milk
don't mess with texas
dont mess with texas
live laugh love
bazinga
hakuna matata
let it go frozen
do you want to build a snowman
it's a small world
how you doin
we're on a break
that's what she said
i'm the captain now
this is sparta
you shall not pass
my precious
i am groot
i am iron man
i'm batman
i am your father
no soup for you
how about a hug
hodor
winter has come
the north remembers
valar morghulis
a lannister always pays his debts
you know nothing jon snow
i drink and i know things
dracarys
wakanda forever
avengers assemble
i can do this all day
hulk smash
with great power comes great responsibility
to the batmobile
holy smokes batman
it's a bird it's a plane
gotta catch em all
gotta catch 'em all
pokemon go
yeet the planet
stay wild moon child
dude perfect
team edward
team jacob
swiftie
beyhive
belieber
directioner
little monsters
swifties
barbz
army bts
`),
};

const KINDS = ['brand', 'league', 'team', 'franchise', 'character', 'celebrity', 'phrase', 'custom'];

module.exports = { SEED, SEED_VERSION, KINDS };
