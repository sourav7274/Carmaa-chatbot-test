import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    user_id: {
      type: String,
    },
    name: String,
    mobile_number: {
      type: Number,
    },
    email: {
      type: String,
    },
    latitude: {
      type: String,
    },
    longitude: {
      type: String,
    },
    cars: [
      {
        id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'car',
        },
        car_name: String,
        car_type: String,
        status: String,
        primary: Boolean,
        vehicle_number: String,
      },
    ],
    status: String,
    is_verified: Boolean,
    bookings: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'booking',
      },
    ],
    cart: [
      {
        vehicle: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'car',
        },
        userVehicleId: {
          type: String, // To identify the specific user car subdocument
        },
        service: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'service',
        },
        quantity: {
          type: Number,
          default: 1,
        },
        addOns: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'service',
          },
        ],
      },
    ],
    wishlist: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'service',
      },
    ],
    wallet: Number,
    total_earned: Number,
    total_redeemed: Number,
    total_water_saving: Number,
    total_water_saved: { type: Number, default: 0 },
    coupon: [
      {
        coupon_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'coupon_code',
        },
        coupon_code: String,
        used: Boolean,
      },
    ],
    pincode: Number,
    user_address: [
      {
        tag: String,
        address: String,
        primary: Boolean,
        pincode: Number,
        latitude: String,
        longitude: String,
        region_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "city"
        },
        flat: String,
        floor: String,
        landmark: String,
        name: String,
        city: String,
        status: {
          type: String,
          default: 'active', // takees 2 "active" and "deleted"
        },
      },
    ],
    contact: [],
    location_address: String,
    notification_token: String,
    os: String,
    app_version: String,
    lastNewsFetchTime: {
      type: Date,
      default: null,
    },
    last_login: String,

    // Referral System Fields
    referralCode: {
      type: String,
      unique: true,
      sparse: true, // sparse allows nulls but keeps it unique if present
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      default: null,
    },
    hasCompletedFirstBooking: {
      type: Boolean,
      default: false,
    },
    is_scratched: { type: Boolean, default: false },
    scratched_at: { type: Date }
  },
  { timestamps: true },
);

export const User = mongoose.model('user', userSchema);
