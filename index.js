// step-1
const express = require('express')
const cors = require('cors')
const app = express()
require('dotenv').config()
// step-3
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// step-8 payment
const stripe = require('stripe')(process.env.STRIPE_SECRET);


// console.log(process.env) // remove this after you've confirmed it is working
const port = process.env.PORT || 3000

// step-10 generate tracking id
const crypto = require("crypto");

// step-15
const admin = require("firebase-admin");

const serviceAccount = require("./swift-parcel-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


function generateTrackingId() {
    const prefix = "SWIFT"; // your brand prefix
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

    return `${prefix}-${date}-${random}`;
}



// step-2
// middleware
app.use(express.json())
app.use(cors());

// step-13 middleware for access token
const verifyFBToken = async (req, res, next) => {
    // console.log('headers in the middleware', req.headers.authorization);
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).send({ messege: 'unauthorized access' })
    }
    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        console.log('decoded in the token', decoded);
        req.decoded_email = decoded.email;
        next();

    }
    catch (err) {
        return res.status(401).send({ messege: 'unauthorized access' })

    }

}

// step-4
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xr2sv5h.mongodb.net/?appName=Cluster0`

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// step-5
async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        // step-6
        const db = client.db('swiftParcelDB');
        const userCollection = db.collection('users')
        const parcelsCollection = db.collection('parcels')
        const paymentCollection = db.collection('payments')
        const ridersCollection = db.collection('riders')

        // step-16 users related api
        app.post('/users', async (req, res) => {
            const user = req.body;
            user.role = 'user';
            user.createdAt = new Date();

            const email = user.email;
            const userExists = await userCollection.findOne({ email });
            if (userExists) {
                return res.send({ messege: 'user already exists' })
            }


            const result = await userCollection.insertOne(user);
            res.send(result);

        })

        // step-7 all parcel api
        app.get('/parcels', async (req, res) => {
            const query = {}
            const { email } = req.query;
            if (email) {
                query.senderEmail = email;
            }
            // sort by created time
            const options = { sort: { createdAt: -1 } }
            const cursor = parcelsCollection.find(query, options);
            const result = await cursor.toArray()
            res.send(result)
        })
        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const result = await parcelsCollection.findOne(query);
            res.send(result)
        })
        app.post('/parcels', async (req, res) => {
            const parcel = req.body;
            // parcel created time
            parcel.createdAt = new Date();
            const result = await parcelsCollection.insertOne(parcel);
            res.send(result)
        })
        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id;

            const query = { _id: new ObjectId(id) }
            const result = await parcelsCollection.deleteOne(query);
            res.send(result)
        })

        // step-9 payment related api
        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100

            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        // Provide the exact Price ID (for example, price_1234) of the product you want to sell
                        // price: '{{PRICE_ID}}',
                        price_data: {
                            currency: 'EUR',
                            unit_amount: amount,
                            product_data: {
                                name: `Please pay for: ${paymentInfo.parcelName}`
                            }
                        },

                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                mode: 'payment',
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName,
                },
                success_url: `${process.env.SITE_DOMEIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMEIN}/dashboard/payment-cancelled`,
            });
            console.log(session);
            res.send({ url: session.url })
            // res.redirect(303, session.url);
        });

        // step-9 new api
        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;
            // console.log('session id', sessionId);
            const session = await stripe.checkout.sessions.retrieve(sessionId)
            // console.log('Session', session);

            // for removing the duplicating payment data
            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId }


            const paymentExist = await paymentCollection.findOne(query);
            console.log(paymentExist);

            if (paymentExist) {
                return res.send({
                    messege: 'already exists',
                    transactionId,
                    trackingId: paymentExist.trackingId,

                })


            }
            // end here to remove the two payment data

            const trackingId = generateTrackingId()

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        trackingId: trackingId,

                    }
                }
                const result = await parcelsCollection.updateOne(query, update);


                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId,


                }
                if (session.payment_status === 'paid') {
                    const resultPayment = await paymentCollection.insertOne(payment)

                    res.send({
                        success: true,
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: resultPayment
                    })
                }

            }

            res.send({ success: false })
        })

        // step-11 payment related apis
        // app.get('/payments', async(req, res)=> {         //step-14 before use the jwt middleware token
        app.get('/payments', verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {}

            // step-12 jwt access token related
            // console.log('headers', req.headers);


            if (email) {
                query.customerEmail = email;

                // check email address
                if (email !== req.decoded_email) {
                    return res.status(403).send({ messege: 'forbidden access' })
                }

            }
            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        })

        // riders related api
        app.post('/riders', async (req, res) => {
            const rider = req.body;
            rider.status = 'pending'
            rider.createdAt = new Date();
            const result = await ridersCollection.insertOne(rider);
            res.send(result)
        })

        // all riders collection
        app.get('/riders', async (req, res) => {
            const query = {}
            if (req.query.status) {
                query.status = req.query.status;
            }
            const cursor = ridersCollection.find(query);
            const result = await cursor.toArray()
            res.send(result)
        })

        app.patch('/riders/:id', verifyFBToken, async (req, res)=>{
            const status = req.body.status;
            const id = req.params.id;
            const query = {_id: new ObjectId(id)}
            const updatedDoc = {
                $set: {
                    status: status
                }
            }
            const result = await ridersCollection.updateOne(query, updatedDoc)
            if(status === 'approved'){
                const email = req.body.email;
                const userQuery = {email}
                const updateUser = {
                    $set:{
                        role: 'rider'
                    }
                }
                const userResult = await userCollection.updateOne(userQuery, updateUser);
            }
            res.send(result)
        })

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        //########### Ensures that the client will close when you finish/error##################
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('SwiftParcel server is running!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
