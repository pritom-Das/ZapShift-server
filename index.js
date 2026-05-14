const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const crypto = require("crypto");

const admin = require("firebase-admin");

// const serviceAccount = require("./zapshift-firebase-adminSDK.json");

const decoded = Buffer.from(process.env.FB_SERVICEKEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);
// const { log } = require("console");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middlewares
app.use(express.json());
app.use(cors());

const verifyFirebaseToken = async (req, res, next) => {
  // console.log("header from middleware:", req.headers.authorization);
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send("Unauthorized: No token provided");
  }

  try {
    const idToken = token.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    // console.log("Decoded Firebase Token:", decodedToken);
    req.decoded_email = decodedToken.email;
    next();
  } catch (error) {
    return res.status(401).send("Unauthorized: Invalid token");
  }
};

// console.log("DB_USER:", process.env.DB_USER);
// console.log("DB_PASS:", process.env.DB_PASSWORD);
// connection string
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ijj1cbi.mongodb.net/?appName=Cluster0`;
// stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET);

// mongodb client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_shift_db");
    const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const riderCollection = db.collection("riders");
    const trackingCollection = db.collection("trackings");

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send("Forbidden: Admins only");
      }
      next();
    };
    // log tracking api
    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split("-").join(" "),
        createdAt: new Date(),
      };
      const result = await trackingCollection.insertOne(log);
      return result;
    };

    //........................riders api...........................
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();
      const email = rider.email;
      const riderExist = await riderCollection.findOne({ email });
      if (riderExist) {
        return res.send({ Message: "Rider with this email already exist" });
      }
      const result = await riderCollection.insertOne(rider);
      res.send(result);
    });
    // ..........get riders who are pending for approval.............
    app.get("/riders", async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = riderCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.patch(
      "/riders/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const status = req.body.status;
        const updateDoc = {
          $set: {
            status: status,
            workStatus: "available",
          },
        };
        const result = await riderCollection.updateOne(query, updateDoc);
        if (status === "approved") {
          const email = req.body.email;
          const userQuery = { email };
          const updataUserRole = {
            $set: {
              role: "rider",
            },
          };

          const userResult = await usersCollection.updateOne(
            userQuery,
            updataUserRole,
          );
        }
        res.send(result);
      },
    );
    // Delete a rider application
    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      try {
        const result = await riderCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to delete rider" });
      }
    });
    //.......................users api...........................
    app.get("/users", verifyFirebaseToken, async (req, res) => {
      const cursor = usersCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "user already Exist" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    // get user by id
    app.get("/users/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.findOne(query);
      res.send(result);
    });
    // get user by email and role
    app.get("/user/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });
    // database related middleware to update user role

    app.patch(
      "/users/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updateUserRole = {
          $set: {
            role: roleInfo.role,
          },
        };

        const result = await usersCollection.updateOne(query, updateUserRole);
        res.send(result);
      },
    );
    // .....................tracking api.....................
    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const cursor = trackingCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    //................................................ parcels api...........................
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const options = {
        sort: { createdAt: -1 },
      };
      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.get("/parcel/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus !== "parcel-delivered") {
        // query.deliveryStatus = { $in: ["rider-assigned", "rider-arriving"] };
        query.deliveryStatus = { $nin: ["parcel-delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelCollection.find(query).sort({ updatedAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });
    app.patch("/parcels/:id/assign", async (req, res) => {
      const id = req.params.id;
      const { riderEmail, riderName, deliveryStatus, riderId, trackingId } =
        req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          riderEmail: riderEmail,
          riderName: riderName,
          deliveryStatus: "rider-assigned",
          riderId: riderId,
          trackingId: trackingId,
        },
      };
      const result = await parcelCollection.updateOne(query, updateDoc);
      // update rider work status to on-delivery
      const riderQuery = { _id: new ObjectId(riderId) };
      const updateRiderWorkStatus = {
        $set: {
          workStatus: "in-delivery",
        },
      };
      await riderCollection.updateOne(riderQuery, updateRiderWorkStatus);
      logTracking(trackingId, "rider-assigned");
      res.send(riderQuery);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, trackingId, riderId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };
      const result = await parcelCollection.updateOne(query, updateDoc);
      logTracking(trackingId, deliveryStatus);
      if (deliveryStatus === "parcel-delivered" && result.modifiedCount > 0) {
        const parcel = await parcelCollection.findOne(query);
        if (parcel && parcel.riderId) {
          const riderQuery = { _id: new ObjectId(parcel.riderId) };
          const updateRiderStatus = {
            $set: {
              workStatus: "available",
            },
          };
          await riderCollection.updateOne(riderQuery, updateRiderStatus);
        }
      }

      res.send(result);
    });
    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      // console.log("here is the parcel:", parcel);
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });
    // payment related apis
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },

            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      // console.log(session);
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const transactionId = session.payment_intent;

        // 1. Unified check for existing payment
        const paymentExists = await paymentCollection.findOne({
          transactionId,
        });
        if (paymentExists) {
          return res.send({
            success: true,
            message: "Payment already processed",
            trackingId: paymentExists.trackingId,
          });
        }

        if (session.payment_status === "paid") {
          const parcelId = session.metadata.parcelId;
          const generatedTrackingId = `ZS-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

          // 2. Update the original Parcel
          const updateResult = await parcelCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            {
              $set: {
                paymentStatus: "paid",
                trackingId: generatedTrackingId,
                deliveryStatus: "pending-pickup",
              },
            },
          );

          // 3. Create Payment Record
          const payment = {
            parcelName: session.metadata.parcelName,
            parcelId: parcelId,
            senderEmail: session.customer_email,
            amount: session.amount_total / 100,
            currency: session.currency,
            paymentStatus: session.payment_status,
            transactionId: transactionId,
            paidAt: new Date(),
            trackingId: generatedTrackingId, // Adding this for easier lookup later
          };
          const paymentResult = await paymentCollection.insertOne(payment);

          // 4. Await the log tracking (CRITICAL)
          await logTracking(generatedTrackingId, "pending-pickup");

          // 5. Final Response
          return res.send({
            success: true,
            updateResult,
            paymentResult,
            transactionId,
            trackingId: generatedTrackingId,
          });
        }

        res.status(400).send("Payment not verified");
      } catch (error) {
        console.error("Payment Success Error:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/payments", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.senderEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send("Forbidden: Email mismatch");
        }
      }
      // console.log(req.headers);
      const cursor = paymentCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!",
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("zapshift is listening");
});

app.listen(port, () => {
  // console.log(`Zapshift listening on port ${port}`);
});
